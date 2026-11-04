import { Client } from '@elastic/elasticsearch';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentChunk } from './types/pipeline.types.js';

/** RAG 分块向量索引名 */
const CHUNK_INDEX = 'kh_chunk';
/**
 * 向量索引存储（RAG 链路落库端）
 *
 * <p>写入 Elasticsearch `kh_chunk`，字段含 dense_vector(embedding)，供后续 kNN / 混合检索。</p>
 *
 * <p>职责：</p>
 * - 启动时确保索引 mapping 存在（含 dense_vector）
 * - 按 document_id 删除旧块（重建前先清）
 * - bulk 写入带 embedding 的 chunk
 *
 * <p>坑与取舍：</p>
 * <p>- 写入是「先全量删、再 bulk 写」：_id = chunkId 只能覆盖同一位置的块，
 * 正文变短、块数变少时没人去覆盖尾部旧块，会留下搜得到但正文已不存在的幽灵块。
 * 所以重建前必须调 deleteByDocId（编排器 reindexOne 已经这么做），只靠 upsert 不够。</p>
 * <p>- embedding.dims 取自 EMBEDDING_DIMENSION，与 EmbeddingService 共用同一配置；
 * 改维度必须删索引重建，否则 bulk 会因维度不符整批失败。</p>
 * <p>- 索引 settings 是 1 分片 0 副本：单机开发环境的取舍，生产要补副本数。</p>
 */
@Injectable()
export class VectorIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VectorIndexService.name);
  private es: Client | null = null;
  private readonly esEnabled: boolean;
  private readonly embeddingDims: number;

  constructor(private readonly config: ConfigService) {
    this.esEnabled = this.config.get<string>('ELASTICSEARCH_ENABLED', 'true') !== 'false';
    this.embeddingDims = Number(config.get('EMBEDDING_DIMENSION', 1024));
  }

  /**
   * 启动时连 ES 并确保 kh_chunk 存在：dims 取自配置，所以索引只能在运行时建；
   * 连不上就把 es 置 null，后续写入静默跳过，发布主流程不受影响。
   */
  async onModuleInit() {
    if (!this.esEnabled) {
      this.logger.warn('Elasticsearch 已禁用，RAG 向量索引将跳过写入');
      return;
    }

    const node = this.config.get('ELASTICSEARCH_NODE', 'http://localhost:9200');
    this.es = new Client({ node });
    try {
      const health = await this.es.cluster.health();
      this.logger.log(`VectorIndex ES 已连接：${node}, status=${health.status}`);
      await this.createIndexIfNotExists();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Elasticsearch 不可用，RAG 向量写入将跳过：${message}`);
      this.es = null;
    }
  }

  /** 关闭客户端连接，避免热重载时句柄泄漏 */
  async onModuleDestroy() {
    await this.es?.close();
  }

  /**
   * 删除某文档全部向量块（发布重建 / 下架时调用）。
   *
   * refresh: true 让删除立刻对检索可见，重建完成后紧接着的查询不该再命中旧块；
   * 索引还没建出来时（首次发布、服务刚起）的 index_not_found 直接忽略。
   */
  async deleteByDocId(documentId: string) {
    if (!this.es) {
      this.logger.warn(`跳过删除向量块（ES 不可用）：documentId=${documentId}`);
      return;
    }
    try {
      await this.es.deleteByQuery({
        index: CHUNK_INDEX,
        query: {
          term: { document_id: documentId },
        },
        refresh: true,
      });
      this.logger.log(`已从 ES 删除文档向量块：documentId=${documentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 索引尚不存在时忽略
      if (message.includes('index_not_found')) {
        return;
      }
      this.logger.error(`ES 删除文档块失败：documentId=${documentId}, error=${message}`);
    }
  }

  /**
   * bulk 写入 / 覆盖 chunk（_id = chunkId）。
   *
   * 一次 bulk 写完再 refresh，比逐条 index 少很多往返；_id 幂等，重复发布是覆盖。
   * 但覆盖只对「位置相同」的块有效，块数变少时尾部旧块必须靠 deleteByDocId 清掉。
   * 只要有一条失败就整体抛错：静默的部分成功会让索引半新半旧，比直接失败更难查。
   */
  async indexChunks(chunks: DocumentChunk[]) {
    if (!chunks.length) return;

    if (!this.es) {
      this.logger.warn(`跳过向量索引写入（ES 不可用）：chunks=${chunks.length}`);
      return;
    }

    await this.createIndexIfNotExists();

    const operations = chunks.flatMap((chunk) => [
      { index: { _index: CHUNK_INDEX, _id: chunk.chunkId } },
      this.buildDocMap(chunk),
    ]);

    const response = await this.es.bulk({
      refresh: true,
      operations,
    });

    if (response.errors) {
      const failed = response.items
        .filter((item) => item.index?.error)
        .map((item) => `${item.index?._id}: ${item.index?.error?.reason ?? 'unknown'}`);
      this.logger.error(`ES 批量索引部分失败：${failed.join(', ')}`);
      throw new Error(`ES 批量索引部分失败：${failed.length} 条`);
    }

    this.logger.log(`ES 批量索引成功：${chunks.length} chunks → ${CHUNK_INDEX}`);
  }

  /**
   * 创建 kh_chunk 索引（含 dense_vector）。
   * document_id 用 keyword：雪花 ID 以字符串传递，避免 JS long 精度问题。
   */
  private async createIndexIfNotExists() {
    if (!this.es) return;

    const exists = await this.es.indices.exists({ index: CHUNK_INDEX });
    if (exists) return;
    try {
      await this.es.indices.create({
        index: CHUNK_INDEX,
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          refresh_interval: '5s',
        },
        mappings: {
          properties: {
            chunk_id: { type: 'keyword' },
            document_id: { type: 'keyword' },
            document_title: {
              type: 'text',
              fields: { keyword: { type: 'keyword' } },
            },
            content: { type: 'text' },
            heading: { type: 'keyword' },
            chunk_index: { type: 'integer' },
            total_chunks: { type: 'integer' },
            category_id: { type: 'keyword' },
            author_id: { type: 'keyword' },
            team_id: { type: 'keyword' },
            doc_status: { type: 'integer' },
            publish_time: { type: 'date' },
            indexed_at: { type: 'date' },
            embedding: {
              type: 'dense_vector',
              dims: this.embeddingDims,
              index: true,
              similarity: 'cosine',
            },
          },
        },
      });
      this.logger.log(`ES 索引创建成功：index=${CHUNK_INDEX}, dims=${this.embeddingDims}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('resource_already_exists')) {
        return;
      }
      this.logger.error(`ES 索引创建失败：${message}`);
      throw error;
    }
  }

  private buildDocMap(chunk: DocumentChunk): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      chunk_id: chunk.chunkId,
      document_id: chunk.documentId,
      document_title: chunk.documentTitle,
      content: chunk.content,
      heading: chunk.heading ?? null,
      chunk_index: chunk.chunkIndex,
      total_chunks: chunk.totalChunks,
      category_id: chunk.categoryId ?? null,
      author_id: chunk.authorId ?? null,
      team_id: chunk.teamId ?? null,
      doc_status: chunk.docStatus ?? null,
      publish_time: chunk.publishTime ?? null,
      indexed_at: new Date().toISOString(),
    };
    // 只有拿到向量才写 embedding 字段：空数组/null 会让 dense_vector 的写入报维度错误
    if (chunk.embedding?.length) {
      doc.embedding = chunk.embedding;
    }
    return doc;
  }
}
