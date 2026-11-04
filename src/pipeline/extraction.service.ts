import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  buildExtractionSystemPrompt,
  kgExtractionResultSchema,
  KgExtractionLlmOutput,
  normalizeEntityType,
  normalizeRelationType,
} from './kg-extraction.schema.js';
import { ExtractionResult } from './types/pipeline.types.js';

/**
 * 实体 / 关系抽取服务
 *
 * <p>供 KG 建图使用：从每个 chunk 抽「实体 + 关系」，再写入 Neo4j。</p>
 * <p>ChatOpenAI.withStructuredOutput，不指定 method：qwen-plus 默认 jsonSchema。</p>
 *
 * <p>环境变量：OPENAI_API_KEY / OPENAI_BASE_URL / MODEL_NAME / KG_MAX_ENTITIES / KG_MAX_RELATIONS / KG_LLM_TIMEOUT_MS</p>
 *
 * <p>关键依赖：ChatOpenAI.withStructuredOutput + zod schema（kg-extraction.schema.js）；
 * 由 schema 在调用结束时就约束输出形状，省掉手写 JSON 解析与修补。</p>
 *
 * <p>坑与取舍：</p>
 * <p>- withStructuredOutput 不指定 method，走 qwen-plus 默认的 jsonSchema；换模型可能不支持，
 * 届时需要退回 functionCalling。</p>
 * <p>- 正文截到 4000 字：控 token 成本和超长报错，代价是长块后半段信息不参与抽取。</p>
 * <p>- 一个 chunk 一次串行调用，建图耗时随块数线性增长；maxRetries=0 让失败尽快抛给上层按块降级。</p>
 * <p>- 无 Key 时 structuredLlm 为 undefined，extract 才抛错（构造期不抛），这样应用还能起来，
 * 只是 KG 链路不可用。</p>
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  /** 单 chunk 最多实体数，防止图爆炸 */
  private readonly maxEntities: number;
  private readonly maxRelations: number;
  private readonly structuredLlm?: Runnable<BaseLanguageModelInput, KgExtractionLlmOutput>;

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      undefined;
    this.maxEntities = Number(config.get('KG_MAX_ENTITIES', 12));
    this.maxRelations = Number(config.get('KG_MAX_RELATIONS', 15));

    if (!apiKey) return;

    const baseUrl =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';

    const model =
      config.get<string>('MODEL_NAME') || config.get<string>('LLM_MODEL') || 'qwen-plus';

    const timeout = Number(config.get('KG_LLM_TIMEOUT_MS', 60000));
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 60000;

    const llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.1,
      timeout: timeoutMs,
      maxRetries: 0,
      // DashScope 走 Chat Completions，不要切 OpenAI Responses API
      useResponsesApi: false,
      configuration: { baseURL: baseUrl },
    });

    this.structuredLlm = llm.withStructuredOutput(kgExtractionResultSchema, {
      name: 'extract_knowledge_graph',
    });
  }

  /**
   * 对单个 chunk 做抽取。
   *
   * 空正文直接返回空结果：既省一次 LLM 调用，也避免空 prompt 诱导模型编造实体。
   *
   * @param content chunk 正文
   * @param heading 所属章节标题（给 LLM 当上下文）
   * @param documentTitle 文档标题
   */
  async extract(
    content: string,
    heading: string | null | undefined,
    documentTitle: string,
  ): Promise<ExtractionResult> {
    if (!content?.trim()) {
      return { entities: [], relations: [] };
    }

    return this.extractByLlm(content, heading, documentTitle);
  }

  /**
   * LLM 抽取：system 约束规则，user 塞标题+正文（截断 4000 字防超上下文）。
   */
  private async extractByLlm(
    content: string,
    heading: string | null | undefined,
    documentTitle: string,
  ): Promise<ExtractionResult> {
    if (!this.structuredLlm) {
      throw new Error('KG 抽取未配置 API Key（OPENAI_API_KEY / LLM_API_KEY / DASHSCOPE_API_KEY）');
    }

    const system = buildExtractionSystemPrompt(this.maxEntities, this.maxRelations);
    const user = `文档标题: ${documentTitle}\n章节: ${heading ?? '无'}\n\n内容:\n${content.slice(0, 4000)}`;

    const started = Date.now();
    const parsed = await this.structuredLlm.invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    this.logger.log(
      `KG 抽取完成：title=${documentTitle}, elapsed=${Date.now() - started}ms, chars=${content.length}, entities=${parsed.entities?.length ?? 0}`,
    );

    return this.toExtractionResult(parsed);
  }

  /**
   * 截断数量、规范化类型、丢掉挂空实体的关系。
   *
   * LLM 输出不能全信，这里做三道防线：
   * 1) 数量截断：防止模型一次吐上百个实体把图撑爆；
   * 2) 类型归一：模型爱写中文/自造类型，统一映射回枚举，方便后续按类型筛选；
   * 3) 关系过滤：source/target 必须落在本次抽到的实体里，否则 Neo4j 那边 MATCH 不到端点。
   */
  private toExtractionResult(parsed: KgExtractionLlmOutput): ExtractionResult {
    // 记录本块实际保留的实体名，后面用它判断关系两端是否存在
    const entityNames = new Set<string>();
    const entities: ExtractionResult['entities'] = [];
    // 先按上限截断再清洗：超出的部分直接丢，不做二次筛选
    for (const e of (parsed.entities ?? []).slice(0, this.maxEntities)) {
      const name = (e.name ?? '').trim();
      // 名字为空的实体直接丢：MERGE (:KnowledgeEntity {name: ''}) 会造出一个无意义空节点
      if (!name) continue;
      entityNames.add(name);
      entities.push({
        name,
        type: normalizeEntityType(e.type),
        description: (e.description ?? '').trim(),
        aliases: (e.aliases ?? []).map((a) => String(a).trim()).filter(Boolean),
      });
    }

    const relations: ExtractionResult['relations'] = [];
    // 两端必须都在本次实体集合内：写图时 MATCH 不到端点，这条边会被静默丢弃（不报错）
    for (const r of (parsed.relations ?? []).slice(0, this.maxRelations)) {
      const source = (r.source ?? '').trim();
      const target = (r.target ?? '').trim();
      if (!source || !target || !entityNames.has(source) || !entityNames.has(target)) {
        continue;
      }
      relations.push({
        source,
        target,
        relation: normalizeRelationType(r.relation ?? r.type),
        // 权重缺失时给 0.5 中值，避免 undefined 混进 Cypher 参数
        weight: typeof r.weight === 'number' ? r.weight : 0.5,
      });
    }
    return { entities, relations };
  }
}
