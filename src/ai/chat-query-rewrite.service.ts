/**
 * 检索改写：把依赖上文的追问改写成可独立检索的短查询，并判断是否需要查库。
 *
 * 职责：
 * - 输入当前问题 + 对话历史，输出 { query, needRetrieve }。
 * - 只服务检索环节，最终回答仍用用户原问题，改写结果不会展示给用户。
 *
 * 关键依赖：
 * - ChatOpenAI + withStructuredOutput(zod rewriteSchema)，缺 LLM key 时直接回退。
 * - chat-memory.util.js 的 compactRewriteContext 负责压缩历史上下文。
 *
 * 坑：
 * - 上下文里助手回答只留 120 字：制度条文、时限、负责人一旦进了改写上下文，
 *   会被模型当成用户诉求补进 query，检索引擎就再也检不到原始意图。
 * - 无历史、无 LLM、上下文为空、调用异常，一律回退「原问题 + needRetrieve=true」，
 *   宁可多检一次，也不要漏检导致答非所问。
 * - prompt 明确禁止编造上文没出现的条款号、系统名，否则会拿去检索不存在的制度。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { compactRewriteContext } from './chat-memory.util.js';

const rewriteSchema = z.object({
  standalone_query: z.string().describe('可独立检索的一句中文短查询，消解指代和省略，不含寒暄'),
  need_retrieve: z.boolean().describe('是否需要查知识库。寒暄、致谢、与制度无关的闲聊为 false'),
});

const REWRITE_PROMPT =
  '你是企业知识库的检索改写器。根据对话把当前问题改写成一条可独立检索的短查询。\n' +
  '\n' +
  '## 要求\n' +
  '- 消解「这个 / 那个 / 谁负责 / 怎么办」等指代，补全省略的主题\n' +
  '- 只保留检索需要的实体、事项、动作，一句中文，尽量不超过 40 字\n' +
  '- 不要编造上文没出现的专有名词、条款号、系统名\n' +
  '- 不要复述助手给出的制度条文、时限、流程细节\n' +
  '- 当前问题已经完整、不依赖上文时，standalone_query 用原问题略作精炼即可\n' +
  '- 寒暄、致谢、与知识库无关 → need_retrieve=false，standalone_query 仍给原问题\n' +
  '- 输出不要解释';

/**
 * 检索计划：query 用于召回，needRetrieve 决定是否跳过知识库。
 */
export type RetrieveQueryPlan = {
  query: string;
  needRetrieve: boolean;
};

/**
 * 检索前把追问改写成独立短查询。未配置 LLM 或改写失败时回退原文。
 */
@Injectable()
export class ChatQueryRewriteService {
  private readonly logger = new Logger(ChatQueryRewriteService.name);
  private readonly rewriter?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof rewriteSchema>>;
  };

  /**
   * 没有可用 LLM key 时 rewriter 留空，rewrite 直接回退原问题：
   * 改写是锦上添花，不能变成问答的前置依赖。
   */
  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      '';
    if (!apiKey) return;

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
      timeout: Number(config.get('AI_QUERY_REWRITE_TIMEOUT_MS', 15000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.rewriter = llm.withStructuredOutput(rewriteSchema) as ChatQueryRewriteService['rewriter'];
  }

  /**
   * 首轮没有指代可消解、或改写链路任何一环不可用，都返回「原问题 + needRetrieve=true」，
   * 保证退化成「直接拿原问题检索」，而不是不检索。
   * 返回值只用于检索，最终回答仍以用户原问题为准。
   */
  async rewrite(question: string, history: BaseMessage[]): Promise<RetrieveQueryPlan> {
    const fallback: RetrieveQueryPlan = { query: question, needRetrieve: true };
    if (!history.length || !this.rewriter) return fallback;

    const context = compactRewriteContext(history);
    if (!context) return fallback;

    try {
      const result = await this.rewriter.invoke([
        new SystemMessage(REWRITE_PROMPT),
        new HumanMessage(`对话：\n${context}\n\n当前问题：${question}`),
      ]);
      const query = result.standalone_query.trim() || question;
      this.logger.log(`检索改写：needRetrieve=${result.need_retrieve} query=${query.slice(0, 80)}`);
      return { query, needRetrieve: result.need_retrieve };
    } catch (error) {
      this.logger.warn(
        `检索改写失败，使用原问题：${error instanceof Error ? error.message : error}`,
      );
      return fallback;
    }
  }
}
