import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { HybridRetrievalService } from './hybrid-retrieval.service.js';
import { ChunkHit } from '../pipeline/types/pipeline.types.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { dbRowsToMessages } from './chat-memory.util.js';
import { retrieveUntilRelevant } from './agentic-retrieve.js';
import { WebSearchService, type WebSearchResult } from './web-search.service.js';
import { ChatQueryRewriteService, type ChatIntent } from './chat-query-rewrite.service.js';

import type { ChatSource } from './chat.types.js';

export type { ChatSource } from './chat.types.js';

const EXCERPT_LEN = 200;
const CITATION_RE = /\[(\d+)\]/g;

/**
 * RAG 对话：混合检索 → 拼 context → LLM 作答 → 解析引用
 *
 * 关键依赖：
 * - HybridRetrievalService 负责混合召回，文档可见范围由 AuthUser 决定。
 * - ChatQueryRewriteService 负责意图路由、切题评估与检索改写，和流式接口共用同一套判定。
 * - agentic-retrieve 的 retrieveUntilRelevant 是无 Agent 时的等价环：查 → 评估 → 不足则改写再查。
 * - ChatSessionService / ChatShortMemoryService / ChatLongMemoryService 负责会话、短期窗口与长期记忆。
 * - WebSearchService 只在前述条件满足时联网，不参与知识库切题判定。
 *
 * 设计要点：
 * - **kb 意图检索不切题时直接短路**，不把空 context 丢给模型（否则必然诱发臆答）；
 * - system prompt 是「引用契约」：只依据资料回答、不足就说不知道、句末标 [n]、编号必须与列表一致；
 * - `sources` 只回填答案里**实际出现**的编号（见 toCitedSources），避免「列了 5 条只用 1 条」的假溯源；
 * - 没配 LLM Key 时构造期不抛错，调用时才抛 503，保证服务能正常启动。
 *
 * 坑：
 * - 非流式没有 Agent 工具环，检索判定必须复用 agentic-retrieve；另写一套会让同一问题在流式与非流式给出不同结论。
 * - web 的调用条件是「先库后网」的代码表达，改成无条件联网，kb 检索不到时就会改用网页作答，而不是说「知识库里没有」。
 * - `sources` 未标注时才回退为全部召回，其余情况只回填被引用的编号；始终全量返回会让前端把「召回 5 条」显示成「引用 5 条」。
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly llm?: ChatOpenAI;

  constructor(
    config: ConfigService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
    private readonly webSearch: WebSearchService,
  ) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      undefined;
    if (!apiKey) {
      return;
    }

    const baseUrl =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const model =
      config.get<string>('MODEL_NAME') || config.get<string>('LLM_MODEL') || 'qwen-plus';

    this.llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL: baseUrl },
    });
  }

  /**
   * 问答主流程：classify 路由 → retrieveUntilRelevant（查 → 评估 → 不足则改写再查）
   * → 按「先库后网」决定是否联网 → 拼 prompt 调模型 → 只回填被引用的 sources。
   *
   * 和流式接口共用 classify / retrieveAndGrade / rewriteAfterRetrieve 这套判定，
   * 只是这里没有 Agent 工具环，顺序由代码写死；非流式要尽量和流式给出一致结论。
   * @param question 用户问题
   * @param topK 检索条数（同时决定 context 里 [1]..[n] 的编号范围）
   * @returns { answer, sources }，sources 只含被引用的资料
   */
  async chat(question: string, topK = 5, user?: AuthUser, sessionId?: string) {
    const trimmed = question.trim();
    if (!trimmed) {
      return {
        sessionId: sessionId ?? null,
        answer: '请输入问题。',
        sources: [] as ChatSource[],
      };
    }

    const history = user ? await this.loadWorkingHistory(user.userId, sessionId) : [];
    const plan = await this.queryRewrite.classify(trimmed, history);
    // 记忆召回先发起、等检索跑完再 await，和检索并行，少一次串行等待
    const memHitsP = user
      ? this.longMemory.search(user.userId, sessionId, plan.query)
      : Promise.resolve({ user: [] as string[], session: [] as string[] });
    // 非流式没有 Agent 工具环，但检索仍走同一套：评估切题，不足则改写再查。
    let hits = [] as ChunkHit[];
    let kbInsufficient = false;
    let searchQuery = plan.query || trimmed;
    if (plan.allowRetrieve) {
      const retrieved = await retrieveUntilRelevant({
        question: trimmed,
        query: plan.query,
        topK,
        user,
        retrieval: this.retrieval,
        rewrite: this.queryRewrite,
      });
      hits = retrieved.hits;
      kbInsufficient = !retrieved.eval.ok;
      searchQuery = retrieved.usedQuery || searchQuery;
    }
    // 先库后网：只有允许联网、且（本轮不查库 或 查了但不切题）才搜。
    // kb 意图 allowWeb 为 false，即使 kbInsufficient 也不会联网，下面的短路分支据此直接给结论
    const web =
      plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
        ? await this.webSearch.search(searchQuery)
        : undefined;
    const memHits = await memHitsP;
    // kb 意图且检索不切题：直接给结论，不联网、不调模型，避免空 context 诱发编造；
    // 仍照常落库，保持会话连续，下一轮还能接着问
    if (plan.intent === 'kb' && kbInsufficient) {
      const empty = {
        answer: '知识库里没有相关内容。',
        sources: [] as ChatSource[],
      };
      const session = user
        ? await this.sessions.appendTurn(
            user.userId,
            sessionId,
            trimmed,
            empty.answer,
            empty.sources,
          )
        : null;
      if (user && session) {
        await this.shortMemory.appendTurn(user.userId, session.id, history, trimmed, empty.answer);
        this.longMemory.rememberTurn(user.userId, session.id, trimmed, empty.answer);
      }
      return { sessionId: session?.id ?? sessionId ?? null, ...empty };
    }

    // 构造期没抛错（保证服务能启动），这里才 503，让调用方明确知道是没配 Key 而不是检索不到
    if (!this.llm) {
      throw new ServiceUnavailableException(
        '未配置 OPENAI_API_KEY / LLM_API_KEY / DASHSCOPE_API_KEY，无法生成回答',
      );
    }

    const memoryMsg = this.longMemory.buildSystemMessage(memHits);
    const parts: string[] = [];
    if (hits.length) parts.push(`知识库资料：\n${this.buildContext(hits)}`);
    if (web) parts.push(`联网结果：\n${this.buildWebContext(web)}`);
    parts.push(`用户问题：${trimmed}`);
    const userTurn = parts.join('\n\n');
    const response = await this.llm.invoke([
      new SystemMessage(this.buildSystemPrompt(plan.intent, Boolean(hits.length), web)),
      ...(memoryMsg ? [memoryMsg] : []),
      ...history,
      new HumanMessage(userTurn),
    ]);

    const answer =
      typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

    const sources = this.toCitedSources(answer, hits);
    this.logger.log(
      `RAG 对话完成：hits=${hits.length}, cited=${sources.length}, answerLength=${answer.length}`,
    );

    const session = user
      ? await this.sessions.appendTurn(user.userId, sessionId, trimmed, answer, sources)
      : null;

    if (user && session) {
      await this.shortMemory.appendTurn(user.userId, session.id, history, trimmed, answer);
      void this.longMemory.rememberTurn(user.userId, session.id, trimmed, answer);
    }

    return { sessionId: session?.id ?? sessionId ?? null, answer, sources };
  }

  /** 短期记忆优先；未命中回填数据库最近 N 条并写回缓存，避免每轮都打库 */
  private async loadWorkingHistory(
    userId: string,
    sessionId: string | undefined,
  ): Promise<BaseMessage[]> {
    if (!sessionId) return [];
    const cached = await this.shortMemory.tryLoad(userId, sessionId);
    if (cached) return cached;
    const rows = await this.sessions.listRecentMessages(
      userId,
      sessionId,
      this.shortMemory.windowSize,
    );
    const history = dbRowsToMessages(rows);
    if (history.length) {
      await this.shortMemory.save(userId, sessionId, history);
    }
    return history;
  }

  /** 从回答中抽出 [n]，只返回实际引用的资料；未标注时回退为全部召回（摘录）。 */
  private toCitedSources(answer: string, hits: ChunkHit[]): ChatSource[] {
    const cited = new Set<number>();
    for (const match of answer.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= hits.length) cited.add(n);
    }

    const indexes = cited.size > 0 ? [...cited].sort((a, b) => a - b) : hits.map((_, i) => i + 1);
    return indexes.map((index) => this.toSource(index, hits[index - 1]));
  }

  /** ChunkHit → ChatSource：正文只给 200 字摘录，不回吐整块内容 */
  private toSource(index: number, hit: ChunkHit): ChatSource {
    return {
      index,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: this.excerpt(hit.content),
      score: hit.score,
    };
  }

  /** 压平空白并截断到 200 字，超出补省略号 */
  private excerpt(content: string): string {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text.length <= EXCERPT_LEN) return text;
    return `${text.slice(0, EXCERPT_LEN)}...`;
  }

  /**
   * 把命中块拼成带编号的资料列表：`[n] 标题 / 章节\n正文`，每块正文截 800 字。
   * 这里的 n 就是模型被要求标注的编号，与 toCitedSources 的解析一一对应。
   */
  private buildContext(hits: ChunkHit[]): string {
    return hits
      .map((src, i) => {
        const heading = src.heading ? ` / ${src.heading}` : '';
        const snippet = src.content.length > 800 ? `${src.content.slice(0, 800)}...` : src.content;
        return `[${i + 1}] ${src.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n');
  }

  /** 联网结果转成 context；搜索失败也把原因写进去，模型才能说明未获取到公开信息 */
  private buildWebContext(web: WebSearchResult): string {
    if (web.error) return web.error;
    if (!web.items.length) return '无结果。';
    return web.items
      .map((hit, i) => `${i + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`)
      .join('\n\n');
  }

  /**
   * 按意图拼 system prompt，本质是一份「引用契约」：
   * hasKb 才要求标 [n]（没有资料还要求标号，模型会凭空编号）；
   * kb 系列无资料时明确禁止编造内部制度；web 结果只允许当公开信息补充。
   * 编号规则必须和 buildContext 的 [i+1]、toCitedSources 的解析保持一致。
   */
  private buildSystemPrompt(intent: ChatIntent, hasKb: boolean, web?: WebSearchResult): string {
    let prompt =
      '你是企业知识库助手。结合对话历史和记忆里的用户背景回答。' +
      '制度/流程以本轮知识库资料为准，不要用记忆替代文档。';
    if (hasKb) {
      prompt +=
        '凡是依据某条资料作出的陈述，必须在句末标注对应编号，如 [1]、[2]。' +
        '编号必须与资料列表一致，不要标注未使用的编号，不要编造文档标题或链接。';
    } else if (intent === 'kb' || intent === 'kb_then_web') {
      prompt += '知识库没有切题资料，不要编造内部制度。';
    }
    if (web?.items.length) {
      prompt += '联网结果只作公开信息补充，用标题+链接说明，不要写成公司内部规定。';
    }
    if (intent === 'chitchat' || intent === 'profile') {
      prompt += '可回应寒暄或个人偏好，不要编造制度。';
    }
    prompt += '若资料不足以回答，明确说不知道。回答简洁，必要时列出条目。';
    return prompt;
  }
}
