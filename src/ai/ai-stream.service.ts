import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
  UIMessageStreamWriter,
} from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createAgent, modelCallLimitMiddleware, tool, summarizationMiddleware } from 'langchain';
import { z } from 'zod';
import type { Response } from 'express';
import { HybridRetrievalService } from './hybrid-retrieval.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { WebSearchService } from './web-search.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import { ChatQueryRewriteService, type ChatRoutePlan } from './chat-query-rewrite.service.js';
import { retrieveAndGrade, type RetrieveEval } from './agentic-retrieve.js';
import {
  formatGraphContext,
  GraphBuildService,
  type GraphChatHit,
} from '../pipeline/graph-build.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import type { ChatSource } from './chat.types.js';
import type { ChatStreamDto } from './dto/chat-stream.dto.js';
import type { ChunkHit } from '../pipeline/types/pipeline.types.js';
import { dbRowsToMessages } from './chat-memory.util.js';
import { accessFromUser } from '../document/document-access.js';

/**
 * 流式问答服务：把「RAG 检索 + 会话管理 + LangChain Agent」编排成一条 SSE 回复。
 *
 * 关键依赖：
 * - createUIMessageStream / pipeUIMessageStreamToResponse（ai）：只提供 UI Message 协议与写出管道。
 * - toUIMessageStream（@ai-sdk/langchain）：把 LangChain 的 token / 工具事件转成 data stream 协议。
 * - HybridRetrievalService 负责召回，ChatSessionService 负责会话与轮次落库，WebSearchService 提供联网兜底。
 * - ChatQueryRewriteService 负责意图路由与检索改写：plan 决定本轮挂哪些工具，切题评估也从这里走。
 *
 * 坑：
 * - createUIMessageStream 只给协议，会话、检索状态、来源这些业务事件得自己写进流，不写前端就没有。
 * - 控制器用 @Res() 手动 pipe，流一旦开始输出就不能再 throw，出错只能写 error part。
 * - start / finish 的所有权在外层 execute，内层 toUIMessageStream 必须关掉，重复会让前端把一条消息切成两段。
 * - 检索与落库失败都只 warn：答案可能已经流给用户，不能再改写成错误。
 */

const EXCERPT_LEN = 200;

/**
 * 自定义 data part 的形状：status / think / sources / retrieve / session。
 * 声明成泛型是为了 writer.write 时能校验 data 结构，前端按同名 data-* 事件取用。
 */
type KhUIMessage = UIMessage<
  unknown,
  {
    /** 过程条状态文案，如正在识别意图 */
    status: { stage: string; text: string };
    think: { text: string };
    sources: ChatSource[];
    retrieve: {
      query: string;
      items: Array<{
        index: number;
        documentId: string;
        documentTitle: string;
        heading: string | null;
      }>;
    };
    /** 意图识别卡 */
    intent: {
      intent: ChatRoutePlan['intent'];
      label: string;
      query: string;
      graphQueries: string[];
      allowRetrieve: boolean;
      allowGraph: boolean;
      allowWeb: boolean;
    };
    /** 检索切题评估卡 */
    eval: RetrieveEval;
    /** 图谱实体与关系 */
    graph: GraphChatHit;
    session: { sessionId: string };
  }
>;

@Injectable()
export class AiStreamService {
  private readonly logger = new Logger(AiStreamService.name);
  private readonly llm?: ChatOpenAI;
  private readonly compactLlm?: ChatOpenAI;

  constructor(
    config: ConfigService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly webSearch: WebSearchService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
    private readonly graph: GraphBuildService,
  ) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      '';
    const baseURL =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const modelName =
      config.get<string>('MODEL_NAME') || config.get<string>('LLM_MODEL') || 'qwen-plus';
    const enableThinking = config.get<string>('LLM_ENABLE_THINKING') !== 'false';

    // 没有 Key 就不建 agent，把失败推迟到 streamChat 里写成 error part，保证服务本身能启动
    if (!apiKey) return;

    this.llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      streamUsage: false,
      configuration: { baseURL },
      modelKwargs: enableThinking ? { enable_thinking: true } : undefined,
    });
    // 摘要/分类不要开思考，结构化输出更容易稳
    this.compactLlm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
  }

  /**
   * 按本轮意图挂工具，并建出这一轮专用的 Agent。检索、改写、再检索由 Agent 循环调度，工具本身只做一步。
   *
   * 工具是动态挂载的：plan.allowRetrieve 才挂 retrieve_knowledge + rewrite_query，
   * plan.allowWeb 才挂 web_search。闲聊 / 个人偏好那轮模型手里根本没有检索工具，
   * 误检索是从工具层面杜绝的，不是靠提示词求它别查。
   *
   * retrieveCount 与 lastRetrieve 是闭包里的本轮状态，所以这些工具不是无状态函数，
   * 而是「带本轮状态的动作」：改写工具必须知道上次查了什么、评估是否切题，
   * 没有上一次检索就直接报错，而不是凭空编一个检索词。
   *
   * retrieveCount >= 2 是代码级硬上限，system prompt 里的「最多两次」只是软约束；
   * 超限返回 insufficient: true，让模型改用已有资料或转联网，而不是继续空转。
   *
   * 工具内部自己写 data-eval / data-status / data-sources，外层 streamChat 不重复写。
   * middleware 两件事：summarization 压缩长对话，modelCallLimit 给循环兜底（runLimit 6，到限收尾）。
   */
  private createTurnAgent(
    user: AuthUser,
    topK: number,
    persistSources: ChatSource[],
    writer: UIMessageStreamWriter<KhUIMessage>,
    plan: ChatRoutePlan,
    question: string,
  ) {
    if (!this.llm || !this.compactLlm) return undefined;
    const retrieval = this.retrieval;
    const queryRewrite = this.queryRewrite;
    const search = this.webSearch;
    const graph = this.graph;
    const logger = this.logger;
    const tools: StructuredToolInterface[] = [];
    let retrieveCount = 0;
    let lastRetrieve: Awaited<ReturnType<typeof retrieveAndGrade>> | undefined;

    if (plan.allowRetrieve) {
      tools.push(
        tool(
          async (input: { query: string; topK?: number }) => {
            // 硬上限：prompt 里说「最多两次」不算数，这里拦第三次，并明确告诉模型改用已有资料或联网
            if (retrieveCount >= 2) {
              return {
                query: input.query,
                items: [],
                insufficient: true,
                error: '本轮知识库最多检索两次，请根据已有评估作答或联网',
              };
            }
            retrieveCount += 1;
            const result = await retrieveAndGrade({
              question,
              query: input.query,
              topK: input.topK ?? topK,
              user,
              retrieval,
              rewrite: queryRewrite,
              retried: retrieveCount > 1,
              previousQuery: lastRetrieve?.usedQuery,
            });
            lastRetrieve = result;
            writer.write({ type: 'data-eval', data: result.eval });
            // 检索失败不 throw：写成工具结果让模型决定改写或联网，循环不因一次失败中断
            if (result.eval.reason === 'error') {
              logger.warn(`RAG 检索失败：${result.eval.text}`);
              return {
                query: result.usedQuery,
                items: [],
                error: result.eval.text,
                insufficient: true,
                eval: result.eval,
              };
            }
            // 不切题的命中在 agentic-retrieve 里已置空，这里只回评估和 insufficient，不给模型错误资料
            if (!result.eval.ok) {
              return packRetrieveResult([], result.usedQuery, persistSources, writer, {
                insufficient: true,
                eval: result.eval,
              });
            }

            return packRetrieveResult(result.hits, result.usedQuery, persistSources, writer, {
              eval: result.eval,
            });
          },
          {
            name: 'retrieve_knowledge',
            description:
              '检索企业知识库一次（仅当前用户可见文档）并评估是否切题。不会自动再查。eval.ok 为 false 时先 rewrite_query，再用新词再调本工具。本轮最多两次。',
            schema: z.object({
              query: z.string().min(1).describe('适合检索的关键词或短句'),
              topK: z.number().int().min(1).max(10).optional().describe('条数，默认与请求一致'),
            }),
          },
        ),
      );
      tools.push(
        tool(
          async (input: { focus?: string }) => {
            // 依赖闭包里上一次 retrieve_knowledge 的结果；没检索过就没有可改写的对象
            if (!lastRetrieve) {
              return { error: '请先调用 retrieve_knowledge' };
            }
            // 已经切题就别改写：换词只会把本来能答的检索词换坏
            if (lastRetrieve.eval.ok) {
              return {
                error: '当前资料已切题，无需改写',
                query: lastRetrieve.usedQuery,
              };
            }
            writer.write({
              type: 'data-status',
              data: { stage: 'rewrite', text: '正在改写检索词…' },
            });
            // 用上一轮的原始命中 + 切题结论驱动改写，而不是凭问题瞎猜
            const retryQuery = await queryRewrite.rewriteAfterRetrieve(
              question,
              lastRetrieve.usedQuery,
              lastRetrieve.grade,
              lastRetrieve.rawHits,
            );
            if (!retryQuery) {
              return {
                error: '无法改写出与上次不同的检索词',
                previousQuery: lastRetrieve.usedQuery,
                reason: lastRetrieve.eval.text,
              };
            }
            return {
              query: retryQuery,
              previousQuery: lastRetrieve.usedQuery,
              reason: lastRetrieve.eval.text,
              focus: input.focus,
            };
          },
          {
            name: 'rewrite_query',
            description:
              '根据上次检索评估改写检索词。仅在 retrieve_knowledge 返回 insufficient 后调用，再把返回的 query 交给 retrieve_knowledge。',
            schema: z.object({
              focus: z.string().optional().describe('希望改写时强调的缺口，可空'),
            }),
          },
        ),
      );
    }

    if (plan.allowGraph) {
      tools.push(
        tool(
          async (input: { query: string }) => {
            const keywords = [
              ...plan.graphQueries,
              ...(input.query.trim() ? [input.query.trim()] : []),
            ];
            const hit = await graph.retrieveForChat(keywords, 8, accessFromUser(user));
            writer.write({ type: 'data-graph', data: hit });
            return {
              query: hit.query,
              entities: hit.entities,
              relations: hit.relations,
              documents: hit.documents,
              context: formatGraphContext(hit),
              insufficient: !hit.entities.length && !hit.relations.length,
            };
          },
          {
            name: 'retrieve_graph',
            description:
              '检索知识图谱实体与关系（仅当前用户可见文档抽取出的图）。入参必须是短实体名，多个用空格或 / 分隔，例如「发票 / 报销」，不要整句。首次检索知识库时必须与 retrieve_knowledge 在同一次并行调用。图谱只说明实体关系，不能当制度原文。仅当还要查其他实体名时再单独再调。',
            schema: z.object({
              query: z.string().min(1).describe('短实体名，多个用空格或 / 分隔，不要整句'),
            }),
          },
        ),
      );
    }

    if (plan.allowWeb) {
      tools.push(
        tool(
          async (input: { query: string; count?: number }) =>
            search.search(input.query, input.count ?? 5),
          {
            name: 'web_search',
            description:
              '联网搜索公开信息（Bocha）。仅在知识库循环结束后仍 insufficient，或本轮只需公开时效信息时调用。不要用网页替代已切题的知识库资料。',
            schema: z.object({
              query: z.string().min(1).describe('搜索关键词'),
              count: z.number().int().min(1).max(10).optional().describe('条数，默认 5'),
            }),
          },
        ),
      );
    }

    return createAgent({
      model: this.llm,
      tools,
      systemPrompt: systemForPlan(plan),
      middleware: [
        summarizationMiddleware({
          model: this.compactLlm,
          trigger: { messages: 12 },
          keep: { messages: 6 },
          summaryPrompt:
            '用中文简洁总结对话：话题、已确认结论、待办。不要写入知识库条文。\n\n待摘要的对话：\n{messages}\n\n摘要：',
        }),
        modelCallLimitMiddleware({ runLimit: 8, exitBehavior: 'end' }),
      ],
    });
  }

  /**
   * 处理一次流式问答，整条业务流的编排都在 execute 里完成，事件顺序不能随意调换：
   * 1. 写 start，占住流的开头；
   * 2. 问题为空时直接 text + finish 返回，后面全部跳过；
   * 3. 有 sessionId 就 touchTitle 续用旧会话，否则 create 新建，再写 data-session 让前端切过去；
   * 4. 写 data-status(intent) 再 classify 路由；路由必须排在建 agent 之前，因为工具列表由 plan 决定；
   * 5. 写 data-intent，前端立刻能画意图卡；
   * 6. 建 agent 并 merge 模型流：工具循环里的事件（data-eval / data-status(rewrite) /
   *    data-sources / source-document）由工具自己写，这里不重复写；
   * 7. 文本 delta 由 toUIMessageStream 转成协议，finish 交给 createUIMessageStream 收口；
   * 8. 没有 agent（未配 Key）时写 error 再 finish，不能 throw。
   */
  async streamChat(dto: ChatStreamDto, user: AuthUser, res: Response) {
    const question = lastUserText(dto.messages);
    const topK = dto.topK ?? 5;
    let persistSessionId = dto.sessionId;
    let persistSources: ChatSource[] = [];
    let persistHistory: BaseMessage[] = [];

    // SDK 只提供 UI Message 协议；会话、RAG、data-* 和 Agent 流要在 execute 里自己编排
    const stream = createUIMessageStream<KhUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });

        if (!question) {
          writer.write({ type: 'text-start', id: 'empty' });
          writer.write({
            type: 'text-delta',
            id: 'empty',
            delta: '请输入问题。',
          });
          writer.write({ type: 'text-end', id: 'empty' });
          writer.write({ type: 'finish' });
          return;
        }

        const session = dto.sessionId
          ? await this.sessions.touchTitle(user.userId, dto.sessionId, question)
          : await this.sessions.create(user.userId, {
              title: titleFromQuestion(question),
            });
        persistSessionId = session.id;
        writer.write({
          type: 'data-session',
          data: { sessionId: session.id },
        });

        const history = await this.loadWorkingHistory(user.userId, session.id);
        persistHistory = history;

        writer.write({
          type: 'data-status',
          data: { stage: 'intent', text: '正在识别意图…' },
        });
        const memHitsP = this.longMemory.search(user.userId, session.id, question);
        const plan = await this.queryRewrite.classify(question, history);
        writer.write({
          type: 'data-intent',
          data: {
            intent: plan.intent,
            label: plan.label,
            query: plan.query,
            graphQueries: plan.graphQueries,
            allowRetrieve: plan.allowRetrieve,
            allowGraph: plan.allowGraph,
            allowWeb: plan.allowWeb,
          },
        });

        const memHits = await memHitsP;

        const agent = this.createTurnAgent(user, topK, persistSources, writer, plan, question);
        if (!agent) {
          writer.write({
            type: 'error',
            errorText: '未配置 LLM Key，无法生成回答',
          });
          writer.write({ type: 'finish' });
          return;
        }

        const memoryMsg = this.longMemory.buildSystemMessage(memHits);
        const langchainStream = await agent.stream(
          {
            messages: [...(memoryMsg ? [memoryMsg] : []), ...history, new HumanMessage(question)],
          },
          // messages：模型 token/思考；tools：retrieve / web_search，给适配包转成 tool-* 事件
          { streamMode: ['messages', 'tools'] },
        );

        writer.merge(
          toUIMessageStream(mapReasoningStream(langchainStream) as never, {
            // 外层 execute 已写 start，流结束由 createUIMessageStream 收口，避免重复
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              this.logger.warn(`LangChain 流失败：${error.message}`);
            },
          }) as never,
        );
      },
      onFinish: async ({ responseMessage }) => {
        const parts = responseMessage?.parts ?? [];
        const answer = parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim();
        const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
        const sources = used.size ? persistSources.filter((s) => used.has(s.index)) : [];
        if (!question || !persistSessionId) return;
        const finalAnswer = answer || '未能生成回答。';
        try {
          await this.sessions.appendTurn(
            user.userId,
            persistSessionId,
            question,
            finalAnswer,
            sources,
          );
          await this.shortMemory.appendTurn(
            user.userId,
            persistSessionId,
            persistHistory,
            question,
            finalAnswer,
          );
        } catch (error) {
          this.logger.warn(`流式对话落库失败：${error instanceof Error ? error.message : error}`);
        }
        this.longMemory.rememberTurn(user.userId, persistSessionId, question, finalAnswer);
      },
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    await pipeUIMessageStreamToResponse({ response: res, stream });
  }

  /** 短期记忆优先；未命中回填数据库最近 N 条并写回缓存，避免每轮都打库 */
  private async loadWorkingHistory(userId: string, sessionId: string) {
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
      this.logger.log(`短期记忆从库回填：sessionId=${sessionId}, n=${history.length}`);
    }
    return history;
  }
}

/**
 * 百炼兼容口把思考放在 reasoning_content；适配包只认
 * additional_kwargs.reasoning.summary，这里转一下。
 */

async function* mapReasoningStream(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const event of stream) {
    attachDashScopeReasoning(event);
    yield event;
  }
}

/** 递归找 additional_kwargs.reasoning_content 并改写成适配包要的 reasoning.summary；seen 防循环引用 */
function attachDashScopeReasoning(value: unknown, seen = new Set<object>()): void {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) attachDashScopeReasoning(item, seen);
    return;
  }
  const obj = value as Record<string, unknown>;
  const kwargs = obj.additional_kwargs as Record<string, unknown> | undefined;
  if (typeof kwargs?.reasoning_content === 'string' && kwargs.reasoning_content) {
    kwargs.reasoning = {
      summary: [{ type: 'summary_text', text: kwargs.reasoning_content }],
    };
  }
  attachDashScopeReasoning(obj.chunk, seen);
  attachDashScopeReasoning(obj.data, seen);
  attachDashScopeReasoning(obj.kwargs, seen);
  attachDashScopeReasoning(obj.messages, seen);
}

/** 从 useChat 的 parts 结构里取最后一条 user 文本；倒序找，避免把 assistant 的 parts 当成问题 */
function lastUserText(messages: ChatStreamDto['messages'] | undefined): string {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('');
    return text.trim();
  }
  return '';
}

/** 用问题前 30 字做会话标题，超长省略，避免侧边栏被整段问题撑开 */
function titleFromQuestion(question: string) {
  const text = question.replace(/\s+/g, ' ').trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/** 生成来源卡片用的摘录：压缩空白后截到 200 字（EXCERPT_LEN） */
function excerpt(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_LEN) return text;
  return `${text.slice(0, EXCERPT_LEN)}...`;
}

/**
 * Agent 循环的操作手册：检索 → 评估 → 不足则改写再检索 → 仍不足才联网 → 作答。
 *
 * 为什么按 intent 分支拼：模型只能从提示词得知本轮的流程、次数上限和各意图边界，
 * 所以循环步骤、两次上限、kb 不足不编造、web 只作公开补充这些规则都必须写进来。
 * 但提示词只是软约束，真正的兜底在工具挂载与 retrieveCount 硬上限（见 createTurnAgent）。
 */
function systemForPlan(plan: ChatRoutePlan) {
  let prompt =
    '你是企业知识库助手，必须按 Agentic RAG 循环作答，不要跳步。' +
    '结合对话历史和记忆里的用户背景，但制度/流程以本轮检索资料为准。' +
    `本轮意图：${plan.label}。`;
  if (plan.allowRetrieve && plan.allowGraph) {
    const graphHint = plan.graphQueries.length
      ? plan.graphQueries.join(' / ')
      : '从问题抽出的短实体名';
    prompt +=
      `知识库建议检索词「${plan.query}」，图谱建议检索词「${graphHint}」。` +
      '第一步必须在同一次回复里并行调用 retrieve_knowledge 和 retrieve_graph，两个都要调：' +
      '不要先查库再决定是否查图，不要只调其中一个，也不要等一个返回再调另一个。' +
      'retrieve_graph 的 query 必须是短实体名（空格或 / 分隔），不要整句。' +
      '循环：① 并行检索；② 若知识库 eval.ok 则用文档 context 作答并标 [n]，图谱只看实体关系、不能当制度原文；' +
      '③ 若 insufficient，先 rewrite_query，再用新词再次 retrieve_knowledge（知识库最多两次）；图谱词变了才再调 retrieve_graph；' +
      '④ 两次后仍不足再考虑联网。eval.ok 后不要再检索、不要改写。不要第三次 retrieve_knowledge。' +
      '图谱为空不要编造关系。不要用记忆替代文档。';
  } else if (plan.allowRetrieve) {
    prompt +=
      `建议检索词「${plan.query}」，可改写成更准的 query。` +
      '循环：① retrieve_knowledge；② 若 eval.ok 则用 context 作答并标 [n]；' +
      '③ 若 insufficient，先 rewrite_query，再用返回的新词再次 retrieve_knowledge（知识库最多两次）；' +
      '④ 两次后仍不足再考虑联网。eval.ok 后不要再检索、不要改写。不要第三次 retrieve_knowledge。' +
      '不要用记忆替代文档。';
  } else {
    prompt += '不要调用 retrieve_knowledge 或 rewrite_query。';
  }
  if (!plan.allowGraph) {
    prompt += '不要调用 retrieve_graph。';
  }
  if (plan.intent === 'chitchat') {
    prompt += '这是闲聊，直接回应，不要调用任何工具。';
  }
  if (plan.intent === 'profile') {
    prompt += '这是个人偏好或身份问题，根据记忆回答，不要检索知识库。';
  }
  if (plan.intent === 'kb') {
    prompt += '两次检索后仍 insufficient：明确说知识库没有相关内容，禁止编造制度，不要联网。';
  }
  if (plan.intent === 'web') {
    prompt += '用 web_search 查公开信息，用标题+链接说明，不要编造。';
  }
  if (plan.intent === 'kb_then_web') {
    prompt +=
      '先走完知识库循环；两次后仍 insufficient 再 web_search。联网结果用标题+链接说明，不要把网页写成内部制度。';
  }
  if (!plan.allowWeb) {
    prompt += '不要调用 web_search。';
  }
  prompt += '资料不够就明确说不知道。';
  return prompt;
}

/**
 * 命中写入 citations，并推 data-sources；context 给模型，excerpt 给前端。
 *
 * 编号用 offset = persistSources.length 累加，第二轮检索接在 [3][4] 而不是又从 [1] 开始：
 * 前端引用卡片按 index 对应，重新从 1 编号会跟第一轮的 [1][2] 串号，落库的来源也会指错文档。
 */
function packRetrieveResult(
  hits: ChunkHit[],
  query: string,
  persistSources: ChatSource[],
  writer: UIMessageStreamWriter<KhUIMessage>,
  extra: Record<string, unknown> = {},
) {
  const offset = persistSources.length;
  const sources = hits.map((hit, i) => ({
    index: offset + i + 1,
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    heading: hit.heading,
    excerpt: excerpt(hit.content),
    score: hit.score,
  }));
  persistSources.push(...sources);
  writer.write({
    type: 'data-sources',
    data: persistSources,
  });
  for (const src of sources) {
    writer.write({
      type: 'source-document',
      sourceId: src.documentId,
      mediaType: 'text/markdown',
      title: `[${src.index}] ${src.documentTitle}`,
    });
  }

  return {
    query,
    items: sources.map((src) => ({
      index: src.index,
      documentId: src.documentId,
      documentTitle: src.documentTitle,
      heading: src.heading,
      excerpt: src.excerpt,
    })),
    context: hits
      .map((hit, i) => {
        const src = sources[i];
        const heading = hit.heading ? ` / ${hit.heading}` : '';
        const snippet = hit.content.length > 800 ? `${hit.content.slice(0, 800)}...` : hit.content;
        return `[${src.index}] ${hit.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n'),
    ...extra,
  };
}
