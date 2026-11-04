import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * 文本向量化服务（基于 LangChain OpenAIEmbeddings）
 *
 * <p>作用：把 chunk 文本变成固定维度浮点向量，供后续相似度检索。</p>
 *
 * <p>相关环境变量：</p>
 * - EMBEDDING_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY
 * - EMBEDDING_BASE_URL、EMBEDDING_MODEL、EMBEDDING_DIMENSION、EMBEDDING_BATCH_SIZE
 *
 * <p>坑与取舍：</p>
 * <p>- 维度会写死进 ES mapping（kh_chunk.embedding.dims），换模型或改 EMBEDDING_DIMENSION
 * 必须删索引重建，否则 bulk 写入维度不符整批失败。</p>
 * <p>- 批量大小钳到 10：DashScope text-embedding-v3 单请求上限，超了直接 400 InvalidParameter。</p>
 * <p>- 没配 Key 时构造函数直接抛错：向量化没有降级方案，宁可启动失败也别让流水线静默空转。</p>
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  /** 向量维度，需与 ES dense_vector.dims 一致（kh_chunk.embedding） */
  private readonly dimension: number;
  private readonly embeddings: OpenAIEmbeddings;

  constructor(config: ConfigService) {
    this.dimension = Number(config.get('EMBEDDING_DIMENSION', 1024));
    // DashScope text-embedding-v3 单次最多 10 条；超过会 400 InvalidParameter
    const configuredBatch = Number(config.get('EMBEDDING_BATCH_SIZE', 10));
    const batchSize = Math.min(
      Number.isFinite(configuredBatch) && configuredBatch > 0 ? configuredBatch : 10,
      10,
    );
    if (configuredBatch > 10) {
      this.logger.warn(`EMBEDDING_BATCH_SIZE=${configuredBatch} 超过 DashScope 上限，已钳制为 10`);
    }

    const apiKey =
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('未配置 EMBEDDING_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY');
    }

    const baseUrl = config.get(
      'EMBEDDING_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const model = config.get('EMBEDDING_MODEL', 'text-embedding-v3');

    this.embeddings = new OpenAIEmbeddings({
      apiKey,
      model,
      dimensions: this.dimension,
      batchSize,
      // Markdown chunk 保留换行，避免语义被过度压扁
      stripNewLines: false,
      configuration: {
        baseURL: baseUrl,
      },
    });
  }

  /** 单条嵌入：复用批量接口，省一套重复的异常处理 */
  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  /**
   * 批量嵌入（内部按 EMBEDDING_BATCH_SIZE 切片）。
   *
   * 返回顺序与入参严格一一对应，调用方按下标回填 chunk.embedding 即可，不要自己再排序。
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    const vectors = await this.embeddings.embedDocuments(texts);
    this.logger.debug(`嵌入完成：count=${vectors.length}`);
    return vectors;
  }
}
