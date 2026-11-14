/**
 * 对话长期记忆：基于 Mem0 的两层记忆读写。
 *
 * 职责：
 * - user 层（key = userId）存跨会话的身份、岗位、回答偏好与长期约束；
 *   session 层（key = userId + runId）只存本轮任务、进度与临时约定。
 * - 检索时两层分别召回，拼成 SystemMessage 作为背景注入 prompt；
 *   写入前先用 LLM 分类器判定该落哪一层。
 *
 * 关键依赖：
 * - mem0ai 的 MemoryClient，缺 MEM0_API_KEY 时整体禁用（enabled=false）。
 * - ChatOpenAI + withStructuredOutput(zod) 充当写入分类器，缺 LLM key 同样跳过写入。
 *
 * 坑：
 * - 知识库条文、负责人、系统名绝不能写进 user 层：记忆污染比没有记忆更糟，
 *   模型会拿记忆里的旧条文覆盖本轮检索到的最新资料，而且错得很自信。
 * - extractFrom 只放用户原话（数组形式），助手回答仅参与是否写入的判断，
 *   不能作为抽取来源，否则助手转述或编造的内容会被固化成用户记忆。
 * - 召回内容只是背景，buildSystemMessage 结尾必须声明「以本轮检索资料为准」。
 * - rememberTurn 是调用方 void 掉的异步操作，任何失败都只能 warn，
 *   记忆不可用不许影响已经返回的问答。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { MemoryClient } from 'mem0ai';

const memorySchema = z.object({
  write_user: z
    .boolean()
    .describe(
      '写入用户层：换会话仍应保留的身份、岗位、回答偏好、长期约束。不含本轮任务、不含知识库条文。',
    ),

  write_session: z.boolean().describe('写入会话层：仅当前会话的任务、进度、待办、临时约定。'),
  reason: z.string().describe('分类理由，一句话'),
});

const CLASSIFIER_PROMPT =
  '你是企业知识库助手的记忆分类器。判断本轮是否有「新事实」要写入 Mem0。\n' +
  '\n' +
  '## user 层（跨会话）\n' +
  '- 用户身份、岗位、所在团队自称\n' +
  '- 长期偏好：答短一点、只要本团队制度、技术回答带示例\n' +
  '- 持久约束：过敏、语言、称呼\n' +
  '\n' +
  '## session 层（仅当前会话）\n' +
  '- 正在排查的问题、本次要写的文档、已确认的下一步\n' +
  '- 用户说「这次」「本轮」的工作上下文\n' +
  '\n' +
  '## 均不写入\n' +
  '- 寒暄、致谢、纯确认\n' +
  '- 助手根据知识库/检索资料说出的制度、流程、负责人、系统名（那是文档事实，不是用户记忆）\n' +
  '- 联网搜索结果、引用编号 [n]\n' +
  '- 无信息增量的复述\n' +
  '\n' +
  '## 原则\n' +
  '1. 知识库内容永远不要写成 user 记忆\n' +
  '2. 「这次先看差旅制度第三节」→ session，不要标成 user\n' +
  '3. user 与 session 可同时为 true\n' +
  '4. 一次性提问且未产生需跨轮记住的约定 → 均为 false';

/**
 * 两层召回结果：user 是跨会话记忆，session 是当前会话记忆，均已是纯文本行。
 */
export type LongMemoryHits = {
  user: string[];
  session: string[];
};

/**
 * 对话长期记忆（Mem0）。未配置 MEM0_API_KEY 时全部跳过。
 * 记忆只用于改写问题和补上下文，不作制度事实来源。
 */
@Injectable()
export class ChatLongMemoryService {
  private readonly logger = new Logger(ChatLongMemoryService.name);
  private readonly client?: MemoryClient;
  private readonly classifier?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof memorySchema>>;
  };
  private readonly topK: number;

  /**
   * 记忆是「可选增强」，所以这里有两道开关：
   * - 没有 MEM0_API_KEY 就不建 MemoryClient，enabled 为 false，检索/写入/清理全部空转；
   * - 没有可用的 LLM key 就不建分类器，写入前无法判定落哪一层，宁可不写。
   * 两把钥匙缺一，记忆整体跳过，问答主链路照常工作。
   */
  constructor(config: ConfigService) {
    this.topK = Number(config.get('MEM0_TOP_K', 5));
    const mem0Key = config.get<string>('MEM0_API_KEY') || '';
    const host = config.get<string>('MEM0_HOST') || undefined;
    if (mem0Key) {
      this.client = new MemoryClient({
        apiKey: mem0Key,
        ...(host ? { host } : {}),
      });
    } else {
      this.logger.warn('未配置 MEM0_API_KEY，跳过长期记忆');
    }

    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      '';

    if (!apiKey || !this.client) return;

    const baseURL =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const modelName =
      config.get<string>('MODEL_NAME') || config.get<string>('LLM_MODEL') || 'qwen-plus';

    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.classifier = llm.withStructuredOutput(memorySchema) as ChatLongMemoryService['classifier'];
  }

  /** 只有 Mem0 客户端就绪才算启用，上层据此决定是否装配记忆相关步骤 */
  get enabled() {
    return Boolean(this.client);
  }

  /**
   * 两层必须分开查：user 层只按 user_id 过滤（跨会话），session 层用
   * AND[user_id, run_id] 过滤（仅本轮）。混在一起会让本轮任务被当成长期偏好，
   * 或让长期偏好只在本轮生效。没有 sessionId 时只查 user 层。
   * 任何异常都降级为空结构而不抛错：一次 Mem0 抖动不该让整轮问答失败。
   */
  async search(
    userId: string,
    sessionId: string | undefined,
    query: string,
  ): Promise<LongMemoryHits> {
    const empty: LongMemoryHits = { user: [], session: [] };
    if (!this.client) return empty;
    try {
      const userRes = await this.client.search(query, {
        filters: { user_id: userId },
        topK: this.topK,
      });
      const sessionRes = sessionId
        ? await this.client.search(query, {
            filters: {
              AND: [{ user_id: userId }, { run_id: sessionId }],
            },
            topK: this.topK,
          })
        : { results: [] };
      return {
        user: (userRes.results ?? [])
          .map((m) => m.memory)
          .filter((text): text is string => Boolean(text)),
        session: (sessionRes.results ?? [])
          .map((m) => m.memory)
          .filter((text): text is string => Boolean(text)),
      };
    } catch (error) {
      this.logger.warn(`Mem0 检索失败：${error instanceof Error ? error.message : error}`);
      return empty;
    }
  }

  /**
   * 把两层记忆拼成一条 SystemMessage。用户偏好可以听记忆的，制度事实不行，
   * 所以结尾必须显式声明「以本轮检索资料为准」，否则模型会拿记忆里的旧条文答题。
   * 没有命中返回 null，调用方不必往 prompt 里塞空消息。
   */
  buildSystemMessage(hits: LongMemoryHits): SystemMessage | null {
    const blocks: string[] = [];
    if (hits.user.length) {
      blocks.push(`【用户长期记忆】\n${hits.user.map((line) => `- ${line}`).join('\n')}`);
    }
    if (hits.session.length) {
      blocks.push(`【当前会话记忆】\n${hits.session.map((line) => `- ${line}`).join('\n')}`);
    }
    if (!blocks.length) return null;
    return new SystemMessage(
      `${blocks.join('\n\n')}\n\n以上仅作背景，制度/流程以本轮检索资料为准，不要用记忆替代文档。`,
    );
  }

  /**
   * 一轮问答结束后写记忆。调用方是 fire-and-forget（void 调用、不 await），
   * 所以这里必须自己吞掉所有异常，只 warn，不能让记忆失败影响已经返回的回答。
   * 写入前先让分类器判 write_user / write_session：知识库条文、负责人、系统名
   * 一旦进了 user 层会长期污染后续所有会话，宁可少写。
   * extractFrom 只放用户原话，助手回答仅用于让分类器判断该不该写。
   */
  async rememberTurn(
    userId: string,
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    if (!this.client || !this.classifier) return;
    const extractFrom = [{ role: 'user' as const, content: question }];

    try {
      const { write_user, write_session, reason } = await this.classifier.invoke([
        new SystemMessage(CLASSIFIER_PROMPT),
        new HumanMessage(
          `用户：${question}\n助手（仅供判断，不要当作用户事实）：${answer.slice(0, 300)}`,
        ),
      ]);

      const written: string[] = [];
      const addOpts = {
        customInstructions:
          '只用用户说的话抽取记忆，一句完整中文。' +
          '只保存身份、岗位、偏好、约束，或用户声明的本轮任务。' +
          '不要保存制度条文、流程、时限、负责人、系统名、引用编号。' +
          '不要译成英文。',
      };
      if (write_user) {
        await this.client.add(extractFrom, { userId, ...addOpts });
        written.push('user');
      }
      if (write_session) {
        await this.client.add(extractFrom, {
          userId,
          runId: sessionId,
          ...addOpts,
        });
        written.push('session');
      }
      this.logger.log(`Mem0 分类：${reason}；写入=${written.join(',') || '无'}`);
    } catch (error) {
      this.logger.warn(`Mem0 写入失败：${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 清空会话只删 session 层（userId + runId）：本轮任务与进度已无意义，
   * 但 user 层的身份、岗位、长期偏好要跨会话继续生效，不能一起删。
   */
  async clearSession(userId: string, sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.deleteAll({ userId, runId: sessionId });
    } catch (error) {
      this.logger.warn(`Mem0 会话层清理失败：${error instanceof Error ? error.message : error}`);
    }
  }
}
