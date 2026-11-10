import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createUIMessageStream, pipeUIMessageStreamToResponse, type UIMessage } from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { createAgent, modelCallLimitMiddleware, tool } from 'langchain';
import { z } from 'zod';
import type { Response } from 'express';
import { HybridRetrievalService } from './hybrid-retrieval.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { WebSearchService } from './web-search.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import type { ChatSource } from './chat.types.js';
import type { ChatStreamDto } from './dto/chat-stream.dto.js';
import type { ChunkHit } from '../pipeline/types/pipeline.types.js';

/**
 * 流式问答服务：把「RAG 检索 + 会话管理 + LangChain Agent」编排成一条 SSE 回复。
 *
 * 关键依赖：
 * - createUIMessageStream / pipeUIMessageStreamToResponse（ai）：只提供 UI Message 协议与写出管道。
 * - toUIMessageStream（@ai-sdk/langchain）：把 LangChain 的 token / 工具事件转成 data stream 协议。
 * - HybridRetrievalService 负责召回，ChatSessionService 负责会话与轮次落库，WebSearchService 提供联网兜底。
 *
 * 坑：
 * - createUIMessageStream 只给协议，会话、检索状态、来源这些业务事件得自己写进流，不写前端就没有。
 * - 控制器用 @Res() 手动 pipe，流一旦开始输出就不能再 throw，出错只能写 error part。
 * - start / finish 的所有权在外层 execute，内层 toUIMessageStream 必须关掉，重复会让前端把一条消息切成两段。
 * - 检索与落库失败都只 warn：答案可能已经流给用户，不能再改写成错误。
 */

const EXCERPT_LEN = 200;

const SYSTEM =
  '你是企业知识库助手。优先根据「检索到的资料」回答。' +
  '资料不足、需要时效性或外部公开信息时，调用 web_search。' +
  '依据资料的陈述句末标 [n]，与资料编号一致。' +
  '联网结果用标题+链接说明，不要编造。资料不够就明确说不知道。';

/**
 * 自定义 data part 的形状：status / think / sources / retrieve / session。
 * 声明成泛型是为了 writer.write 时能校验 data 结构，前端按同名 data-* 事件取用。
 */
type KhUIMessage = UIMessage<
  unknown,
  {
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
    session: { sessionId: string };
  }
>;

@Injectable()
export class AiStreamService {
  private readonly logger = new Logger(AiStreamService.name);
  private readonly agent?: ReturnType<typeof createAgent>;

  constructor(
    config: ConfigService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly webSearch: WebSearchService,
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

    const llm = new ChatOpenAI({
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

    const search = this.webSearch;

    this.agent = createAgent({
      model: llm,
      tools: [
        // web_search 的 handler 永不抛错（失败也返回带 error 的对象）：工具抛错会打断 Agent 循环
        tool(
          async (input: { query: string; count?: number }) =>
            search.search(input.query, input.count ?? 5),
          {
            name: 'web_search',
            description:
              '联网搜索（Bocha）。知识库不足、需要最新公开信息或外部资料时再调用。不要用它替代知识库已有内容。',
            schema: z.object({
              query: z.string().min(1).describe('搜索关键词'),
              count: z.number().int().min(1).max(10).optional().describe('条数，默认 5'),
            }),
          },
        ),
      ],
      systemPrompt: SYSTEM,
      middleware: [
        // 单次 invoke 最多调 4 次模型，避免 web_search 循环打爆；超限正常结束而非抛错
        modelCallLimitMiddleware({ runLimit: 4, exitBehavior: 'end' }),
      ],
    });
  }

  /**
   * 处理一次流式问答，整条业务流的编排都在 execute 里完成，顺序不能随意调换：
   * 1. 写 start，占住流的开头；
   * 2. 问题为空时直接 text + finish 返回，后面全部跳过；
   * 3. 有 sessionId 就 touchTitle 续用旧会话，否则 create 新建，再写 data-session 让前端切过去；
   * 4. 写 data-status(retrieve) 再检索；检索失败只 warn，hits 保持空继续回答；
   * 5. 写 data-retrieve / data-sources / source-document，供前端渲染来源与引用；
   * 6. 没有 agent（未配 Key）时写 error 再 finish，不能 throw；
   * 7. 拼 prompt 调 agent.stream，最后把模型流 merge 进同一条 SSE。
   */
  async streamChat(dto: ChatStreamDto, user: AuthUser, res: Response) {
    const question = lastUserText(dto.messages);
    const topK = dto.topK ?? 5;
    let persistSessionId = dto.sessionId;
    let persistSources: ChatSource[] = [];

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

        writer.write({
          type: 'data-status',
          data: { stage: 'retrieve', text: '正在检索知识库…' },
        });

        let hits: ChunkHit[] = [];
        // 检索失败只降级为空命中：没有资料也能靠模型自身知识或 web_search 回答，不能因此中断整条流
        try {
          hits = await this.retrieval.retrieve(question, topK);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.warn(`RAG 检索失败：${detail}`);
        }

        const sources = this.toSources(hits);
        persistSources = sources;
        writer.write({
          type: 'data-retrieve',
          data: {
            query: question,
            items: sources.map((src) => ({
              index: src.index,
              documentId: src.documentId,
              documentTitle: src.documentTitle,
              heading: src.heading,
            })),
          },
        });
        writer.write({ type: 'data-sources', data: sources });
        for (const src of sources) {
          writer.write({
            type: 'source-document',
            sourceId: src.documentId,
            mediaType: 'text/markdown',
            title: `[${src.index}] ${src.documentTitle}`,
          });
        }

        // 走到这里 start 已经写出、响应头已发，只能写 error part 再 finish；throw 只会让连接中断
        if (!this.agent) {
          writer.write({
            type: 'error',
            errorText: '未配置 LLM Key，无法生成回答',
          });
          writer.write({ type: 'finish' });
          return;
        }

        const prompt = hits.length
          ? `检索到的资料：\n${this.buildContext(hits)}\n\n用户问题：${question}`
          : `知识库没有召回到相关内容。\n\n用户问题：${question}`;

        const langchainStream = await this.agent.stream(
          {
            messages: [new HumanMessage(prompt)],
          },
          // messages：模型 token/思考；tools：web_search 调用，给适配包转成 tool-* 事件
          { streamMode: ['messages', 'tools'] },
        );

        // 用 merge 而不是 return：业务事件流与模型 token 流必须汇成同一条 SSE，
        // return 会让适配包另起一条流，前端只能收到其中一段
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
      // 流结束后才落库：先从 parts 拼出完整答案，用正则抽出被引用的 [n]，
      // 只保留真正用到的 sources 再 appendTurn；失败只 warn，答案已经流完，不能改成错误
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
        try {
          await this.sessions.appendTurn(
            user.userId,
            persistSessionId,
            question,
            answer || '未能生成回答。',
            sources,
          );
        } catch (error) {
          this.logger.warn(`流式对话落库失败：${error instanceof Error ? error.message : error}`);
        }
      },
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    // 控制器用 @Res() 接了响应，这里负责写响应头并 pipe；上面任何一步都不能再 throw
    await pipeUIMessageStreamToResponse({ response: res, stream });
  }

  /** 把检索命中转成前端用的来源：index 从 1 开始，必须与回答里的 [n] 引用标记严格对齐 */
  private toSources(hits: ChunkHit[]): ChatSource[] {
    return hits.map((hit, i) => ({
      index: i + 1,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: excerpt(hit.content),
      score: hit.score,
    }));
  }

  /** 拼进 prompt 的资料块；每块只截 800 字，避免长文档挤掉问题本身和上下文窗口 */
  private buildContext(hits: ChunkHit[]): string {
    return hits
      .map((src, i) => {
        const heading = src.heading ? ` / ${src.heading}` : '';
        const snippet = src.content.length > 800 ? `${src.content.slice(0, 800)}...` : src.content;
        return `[${i + 1}] ${src.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n');
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
