import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../pipeline/embedding.service.js';
import { VectorIndexService } from '../pipeline/vector-index.service.js';
import { ChunkHit } from '../pipeline/types/pipeline.types.js';
import { RerankerService } from './reranker.service.js';

/**
 * kh_chunk 混合检索编排：关键词 + 向量 → RRF 粗融合 → reranker 精排。
 *
 * 三层降级（任何一层失败都不让问答整体 500）：
 * 1. query 向量化失败 → 只走关键词召回；
 * 2. rerank 未配置 / 调用失败 / 返回空 → 用 RRF 顺序；
 * 3. ES 不可用 → 两路都为空，直接返回 []。
 *
 * 参数来源：RAG_HYBRID_TOP_K（每路召回条数，默认 20）、RAG_RRF_C（RRF 平滑常数，默认 60）。
 */
@Injectable()
export class HybridRetrievalService {
  private readonly logger = new Logger(HybridRetrievalService.name);
  private readonly hybridTopK: number;
  private readonly rrfC: number;

  constructor(
    config: ConfigService,
    private readonly embedding: EmbeddingService,
    private readonly vectorIndex: VectorIndexService,
    private readonly reranker: RerankerService,
  ) {
    this.hybridTopK = Number(config.get('RAG_HYBRID_TOP_K', 20));
    this.rrfC = Number(config.get('RAG_RRF_C', 60));
  }

  /**
   * 检索主流程：粗排（RRF）→ 精排（rerank）→ 截取 topK。
   * @param topK 最终返回条数（默认 5），同时作为 rerank 的 top_n
   */
  async retrieve(query: string, topK = 5): Promise<ChunkHit[]> {
    const queryVector = await this.embedQuery(query);
    const fused = await this.vectorIndex.searchHybrid({
      query,
      queryVector,
      hybridTopK: this.hybridTopK,
      rrfC: this.rrfC,
    });
    if (!fused.length) {
      this.logger.log(`混合检索无结果：queryLength=${query.length}`);
      return [];
    }

    const reranked = await this.reranker.rerank(query, fused, topK);
    if (reranked?.length) {
      return reranked.slice(0, topK);
    }

    return fused.slice(0, topK);
  }

  /** 向量化 query；失败返回 null，让 searchHybrid 自动退化为纯关键词召回 */
  private async embedQuery(query: string): Promise<number[] | null> {
    try {
      return await this.embedding.embed(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`查询向量化失败，仅走关键词：${message}`);
      return null;
    }
  }
}
