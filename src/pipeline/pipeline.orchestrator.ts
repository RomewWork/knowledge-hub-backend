import { Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { DocumentStatus } from '../document/document-status.js';
import {
  DocumentContent,
  DocumentContentDocument,
} from '../document/schemas/document-content.schema.js';
import { ChunkingService } from './chunking.service.js';
import { EmbeddingService } from './embedding.service.js';
import { VectorIndexService } from './vector-index.service.js';
import { PipelineDocument } from './types/pipeline.types.js';
import { SearchIndexService } from './search-index.service.js';
import { GraphBuildService } from './graph-build.service.js';

/**
 * 发布后知识管线编排器（索引流水线域的总入口）
 *
 * <p>按消息 type 分发到三条互相独立的链路：</p>
 * <p>RAG：分块 → Embedding → ES kh_chunk（块 + 向量）</p>
 * <p>Search：回查元数据与正文 → ES kh_document（整篇一条）</p>
 * <p>KG：分块 → 抽实体关系 → Neo4j</p>
 *
 * <p>由 {@link DocumentPipelineConsumer} 在消费到 MQ 消息后调用；</p>
 * <p>本类负责「加载文档 → 调具体服务」，不直接碰 RabbitMQ。</p>
 *
 * <p>关键依赖：Postgres 的 EntityManager（文档元数据）、Mongo 的 DocumentContent 模型（正文），
 * 以及 ChunkingService / EmbeddingService / VectorIndexService / SearchIndexService / GraphBuildService。</p>
 *
 * <p>坑与取舍：</p>
 * <p>- 消息里只带 documentId，正文一律回查 Postgres + Mongo（handleSearchIndex 已不再依赖消息快照）：
 * 消息体小、也不会因为发布后内容又被改过而写入脏快照，代价是消费端多两次库查询。</p>
 * <p>- 每篇文档单独 try/catch：一篇失败不影响同批其余文档，也不至于让整批被 MQ 反复重投。</p>
 * <p>- 下游服务在 ES/Neo4j 不可用时是静默跳过（不抛错），编排层感知不到，所以索引可能「假成功」，
 * 排障时先看下游各自的连接日志。</p>
 */
@Injectable()
export class PipelineOrchestrator {
  private readonly logger = new Logger(PipelineOrchestrator.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorIndexService: VectorIndexService,
    private readonly searchIndexService: SearchIndexService,
    private readonly graphBuildService: GraphBuildService,
  ) {}

  /**
   * 处理 RAG 重建消息 / 删除消息。
   *
   * 重建流水线（单文档）：清旧块 → Chunking → Embedding → 写入 ES kh_chunk
   */
  async handleRagReindex(type: string, documentIds?: string[]) {
    if (type === 'DELETE_BY_DOC_IDS' && documentIds?.length) {
      for (const id of documentIds) {
        await this.vectorIndexService.deleteByDocId(id);
      }
      return;
    }

    if (type !== 'BY_DOC_IDS' || !documentIds?.length) {
      this.logger.warn(`忽略未支持的 RAG 消息：type=${type}`);
      return;
    }

    const docs = await this.loadDocumentsByIds(documentIds);
    this.logger.log(`RAG 开始索引：type=${type}, total=${docs.length}`);

    for (const doc of docs) {
      try {
        await this.reindexOne(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`RAG 索引失败：documentId=${doc.id}, ${message}`);
      }
    }
  }

  /**
   * 处理 Search 索引消息。
   *
   * 消息里现在只带 documentId，不再携带文档快照：INDEX 时按 id 回查 Postgres 元数据 +
   * Mongo 正文，再整篇写入 ES kh_document。这样消息体小，且写入的永远是库里的当前内容。
   * DELETE：按 documentId 删除。
   */
  async handleSearchIndex(type: string, documentId: string) {
    if (type === 'DELETE') {
      await this.searchIndexService.deleteDocument(documentId);
      return;
    }

    if (type === 'INDEX') {
      const docs = await this.loadDocumentsByIds([documentId]);
      const doc = docs[0];
      if (!doc) {
        this.logger.warn(`Search INDEX 文档不存在：documentId=${documentId}`);
        return;
      }
      await this.searchIndexService.indexDocument(this.toSearchIndexDoc(doc));
      return;
    }

    this.logger.warn(`忽略未支持的 Search 消息：type=${type}`);
  }

  /**
   * 处理 KG 建图消息。
   * BUILD_*：读正文 → 分块 → 抽实体关系 → 写 Neo4j
   * DELETE_*：删文档节点及其 chunk / 孤儿实体
   */
  async handleKgBuild(type: string, documentIds?: string[]) {
    if (type === 'DELETE_BY_DOC_IDS' && documentIds?.length) {
      for (const id of documentIds) {
        await this.graphBuildService.deleteForDocument(id);
      }
      return;
    }

    const docs =
      type === 'BUILD_BY_DOC_IDS' && documentIds?.length
        ? await this.loadDocumentsByIds(documentIds)
        : type === 'BUILD_ALL'
          ? await this.loadAllPublishedDocuments()
          : [];

    if (!docs.length) {
      this.logger.warn(`忽略未支持或空的 KG 消息：type=${type}`);
      return;
    }

    this.logger.log(`KG 开始建图：type=${type}, total=${docs.length}`);
    await this.graphBuildService.buildBatch(docs);
  }

  /** 单篇：分块 → 批量嵌入 → 落库 */
  private async reindexOne(doc: PipelineDocument) {
    if (!doc.content?.trim()) {
      this.logger.warn(`文档内容为空，跳过 RAG：documentId=${doc.id}`);
      return;
    }

    // 先清旧块，避免重复发布时脏数据残留
    await this.vectorIndexService.deleteByDocId(doc.id);

    const chunks = await this.chunkingService.chunk({
      content: doc.content,
      documentId: doc.id,
      documentTitle: doc.title,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      docStatus: doc.status,
      publishTime: this.toIsoDate(doc.publishTime),
    });

    if (!chunks.length) return;

    const embeddings = await this.embeddingService.embedBatch(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = embeddings[i];
    }

    await this.vectorIndexService.indexChunks(chunks);
    this.logger.log(`RAG 索引完成：documentId=${doc.id}, chunks=${chunks.length}`);
  }

  /** ES date 字段需要 ISO-8601；Date#toString() 会被拒绝 */
  private toIsoDate(value?: Date | string | null): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  /**
   * 按 ID 列表加载元数据 + Mongo 正文。
   *
   * 逐条查询而非一次 IN：正文在 Mongo 里要按 contentId 关联，逐条更好读；
   * 发布批量通常不大，这点 N+1 可以接受。单条查不到就跳过，不阻断整批。
   */
  private async loadDocumentsByIds(ids: string[]): Promise<PipelineDocument[]> {
    const result: PipelineDocument[] = [];
    for (const id of ids) {
      const doc = await this.em.findOne(DocumentEntity, {
        where: { id, deleted: false },
      });
      if (!doc) continue;
      const contentDoc = await this.contentModel
        .findOne({ _id: doc.contentId, deleted: false })
        .lean();
      result.push(this.toPipelineDoc(doc, contentDoc?.content ?? ''));
    }
    return result;
  }

  /**
   * 加载全部已发布且未删除的文档（BUILD_ALL）。
   *
   * 用于整图重建 / 索引 mapping 变更后的回填；未发布和已删除的文档不参与，避免把草稿写进图谱。
   */
  private async loadAllPublishedDocuments(): Promise<PipelineDocument[]> {
    const docs = await this.em.find(DocumentEntity, {
      where: { deleted: false, status: DocumentStatus.Published },
    });
    const result: PipelineDocument[] = [];
    for (const doc of docs) {
      const contentDoc = await this.contentModel
        .findOne({ _id: doc.contentId, deleted: false })
        .lean();
      result.push(this.toPipelineDoc(doc, contentDoc?.content ?? ''));
    }
    return result;
  }

  /** Postgres 元数据 + Mongo 全文 → ES kh_document 文档 */
  private toSearchIndexDoc(doc: PipelineDocument): Record<string, unknown> {
    return {
      id: doc.id,
      title: doc.title,
      summary: doc.summary ?? null,
      content: doc.content ?? '',
      categoryId: doc.categoryId ?? null,
      tags: doc.tags ?? null,
      status: doc.status,
      isPublic: doc.isPublic,
      viewCount: doc.viewCount,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      authorId: doc.authorId ?? null,
      publishTime: this.toIsoDate(doc.publishTime),
      createdAt: this.toIsoDate(doc.createdAt),
      updatedAt: this.toIsoDate(doc.updatedAt),
    };
  }

  /** Postgres 实体 + Mongo 正文 → 管线统一 DTO */
  private toPipelineDoc(doc: DocumentEntity, content: string): PipelineDocument {
    return {
      id: doc.id,
      title: doc.title,
      content,
      summary: doc.summary,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      status: doc.status,
      tags: doc.tags,
      isPublic: doc.isPublic,
      viewCount: doc.viewCount,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      publishTime: doc.publishTime,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
