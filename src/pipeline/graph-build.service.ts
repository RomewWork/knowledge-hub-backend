import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { ChunkingService } from './chunking.service.js';
import { ExtractionService } from './extraction.service.js';
import { PipelineDocument } from './types/pipeline.types.js';
import {
  neo4jAccessParams,
  neo4jDocumentAccessWhere,
  type DocumentAccessScope,
} from '../document/document-access.js';

/**
 * KG 知识图谱构建
 *
 * <p>图模型（简化）：</p>
 * <pre>
 * (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 * (KnowledgeEntity)-[:RELATED_TO]->(KnowledgeEntity)
 * </pre>
 *
 * <p>单篇构建步骤：</p>
 * <ol>
 *   <li>删除该文档旧图数据（clear before build）</li>
 *   <li>MERGE 文档节点</li>
 *   <li>ChunkingService 分块 → 每块建 DocumentChunk + HAS_CHUNK</li>
 *   <li>ExtractionService 抽实体关系 → MERGE 实体 / RELATED_TO / MENTIONS</li>
 * </ol>
 *
 * <p>关键依赖：ConfigService（NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / NEO4J_ENABLED）、
 * ChunkingService（与 RAG 同一套分块，保证图谱粒度与向量块一致）、
 * ExtractionService（每个 chunk 一次 LLM 调用）。</p>
 *
 * <p>坑与取舍：</p>
 * <p>- buildForDocument 必须先 deleteForDocument 再建：直接重跑会把边和 chunk 节点翻倍；
 * 先清的好处是单块抽取失败只丢那一块，不会留下半新半旧的图。</p>
 * <p>- 实体按 name 全局 MERGE：同名实体跨文档复用是收益，同名不同义被合并是代价。</p>
 * <p>- 建图是逐块串行调 LLM，大文档很慢；失败只记日志不重试，宁可少写也不阻塞发布消费。</p>
 * <p>- 连接在 onModuleInit 里 verifyConnectivity，失败就把 driver 置 null，之后所有方法静默降级。</p>
 *
 * Neo4j 不可用时跳过写入（不抛错阻断发布消费）。
 */
@Injectable()
export class GraphBuildService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphBuildService.name);
  private driver: Driver | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly chunkingService: ChunkingService,
    private readonly extractionService: ExtractionService,
  ) {
    this.enabled = this.config.get<string>('NEO4J_ENABLED', 'true') !== 'false';
  }

  /**
   * 启动时建驱动并验活：验活失败立即 close 并置 null，等于把 KG 链路降级成 no-op，
   * 不影响发布消费和其他两条链路（这是刻意选择，不是遗漏）。
   */
  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Neo4j 已禁用（NEO4J_ENABLED=false）');
      return;
    }
    const uri = this.config.get('NEO4J_URI', 'bolt://localhost:7687');
    const user = this.config.get('NEO4J_USER', 'neo4j');
    const password = this.config.get('NEO4J_PASSWORD', 'password');
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    try {
      await this.driver.verifyConnectivity();
      this.logger.log(`Neo4j 已连接：${uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j 不可用，KG 写入将跳过：${message}`);
      await this.driver.close();
      this.driver = null;
    }
  }

  /** 进程退出时关闭连接池，避免热重载累积悬挂连接 */
  async onModuleDestroy() {
    await this.driver?.close();
  }

  /**
   * 为单篇文档全量重建图谱。
   *
   * 先删后建而不是增量合并：图数据没有版本概念，重跑一次就可能多一倍边，
   * 全量重建的代价是重跑耗时，换来的是结果只跟当前正文有关。
   *
   * @returns 写入的实体数量（近似：同一实体在多块被抽到会重复计数，仅用于日志）
   */
  async buildForDocument(doc: PipelineDocument): Promise<number> {
    if (!this.driver) {
      this.logger.warn(`跳过 KG 构建（Neo4j 不可用）：documentId=${doc.id}`);
      return 0;
    }

    if (!doc.content?.trim()) {
      this.logger.log(`文档内容为空，跳过 KG：documentId=${doc.id}`);
      return 0;
    }

    // 先清再建，避免重复发布导致边/节点翻倍
    await this.deleteForDocument(doc.id);

    const session = this.driver.session();
    const now = new Date().toISOString();
    try {
      // ① 文档节点：按 id 幂等 upsert，保留首次 createdAt
      await session.run(
        `
        // 以文档业务 id 为唯一键：存在则命中，不存在则创建
        MERGE (d:KnowledgeDocument {id: $id})
        // 每次重建都刷新可变元数据；createdAt 仅首次写入
        SET d.title = $title, d.summary = $summary, d.categoryId = $categoryId,
            d.authorId = $authorId, d.teamId = $teamId, d.isPublic = $isPublic,
            d.status = $status, d.tags = $tags,
            d.updatedAt = $now, d.createdAt = coalesce(d.createdAt, $now)
        `,
        {
          id: doc.id,
          title: doc.title,
          summary: doc.summary ?? '',
          categoryId: doc.categoryId ?? null,
          authorId: doc.authorId ?? null,
          teamId: doc.teamId ?? null,
          isPublic: doc.isPublic ?? false,
          status: doc.status,
          tags: doc.tags ?? '',
          now,
        },
      );

      // ② 复用 RAG 同款分块，保证图谱粒度与向量块一致
      const chunks = await this.chunkingService.chunk({
        content: doc.content,
        documentId: doc.id,
        documentTitle: doc.title,
        categoryId: doc.categoryId,
        authorId: doc.authorId,
        teamId: doc.teamId,
        docStatus: doc.status,
        publishTime:
          doc.publishTime instanceof Date
            ? doc.publishTime.toISOString()
            : doc.publishTime
              ? new Date(doc.publishTime).toISOString()
              : null,
      });

      let totalEntities = 0;
      for (const chunk of chunks) {
        // ③ chunk 节点 + 文档→块边：Document -[HAS_CHUNK]-> Chunk
        await session.run(
          `
          // 以全局唯一 chunkId 幂等创建/更新块节点
          MERGE (c:DocumentChunk {chunkId: $chunkId})
          SET c.documentId = $documentId, c.content = $content, c.heading = $heading,
              c.chunkIndex = $chunkIndex, c.totalChunks = $totalChunks, c.updatedAt = $now
          // 携带 c 进入下一子句，避免丢失当前块上下文
          WITH c
          // 找到所属文档（① 已保证存在）
          MATCH (d:KnowledgeDocument {id: $documentId})
          // 文档→块 一对多边；边属性记序号便于按序遍历
          MERGE (d)-[r:HAS_CHUNK]->(c)
          SET r.chunkIndex = $chunkIndex
          `,
          {
            chunkId: chunk.chunkId,
            documentId: doc.id,
            content: chunk.content,
            heading: chunk.heading ?? null,
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            now,
          },
        );

        // ④ 抽实体关系并落图；单块失败不阻断其余块（图已先清过）
        let extracted;
        try {
          extracted = await this.extractionService.extract(chunk.content, chunk.heading, doc.title);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `KG 抽取失败，跳过该块：documentId=${doc.id}, chunk=${chunk.chunkIndex}, ${message}`,
          );
          extracted = { entities: [], relations: [] };
        }
        // 绑定当前块，writeExtraction 才能建 MENTIONS
        // 写入 Neo4j：实体节点 / MENTIONS / RELATED_TO
        extracted.chunkId = chunk.chunkId;
        const written = await this.writeExtraction(session, extracted);
        // 累加本块实体数，仅用于日志；图数据已在上一行入库
        totalEntities += written;
      }

      this.logger.log(
        `KG 图谱构建完成：documentId=${doc.id}, chunks=${chunks.length}, entities=${totalEntities}`,
      );
      return totalEntities;
    } finally {
      await session.close();
    }
  }

  /**
   * 批量建图：单篇失败只记日志，不影响后续文档（失败文档下次发布再补）。
   */
  async buildBatch(docs: PipelineDocument[]) {
    for (const doc of docs) {
      try {
        await this.buildForDocument(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`KG 构建失败：documentId=${doc.id}, ${message}`);
      }
    }
  }

  /** 已发布文档只改公开/团队时，只刷文档节点属性，不必抽实体重建 */
  async updateVisibility(
    documentId: string,
    vis: { isPublic: boolean; teamId: string | null; authorId: string | null },
  ) {
    if (!this.driver) {
      this.logger.warn(`跳过图谱可见性更新（Neo4j 不可用）：documentId=${documentId}`);
      return;
    }
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (d:KnowledgeDocument {id: $id})
        SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId,
            d.updatedAt = $now
        `,
        {
          id: documentId,
          isPublic: vis.isPublic,
          teamId: vis.teamId,
          authorId: vis.authorId,
          now: new Date().toISOString(),
        },
      );
      this.logger.log(`图谱可见性已更新：documentId=${documentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱可见性更新失败：documentId=${documentId}, ${message}`);
    } finally {
      await session.close();
    }
  }

  /**
   * 删除文档及其 chunk；再清理「已无人提及」的孤儿实体，避免图膨胀。
   *
   * 两步必须分开：孤儿判定依赖「全图没有任何 MENTIONS 入边」，只能在文档节点删完之后做，
   * 否则会误删仍被其他文档引用的实体。
   */
  async deleteForDocument(documentId: string) {
    if (!this.driver) return;
    const session = this.driver.session();
    try {
      // 删除文档节点及其所有 chunk（DETACH 会一并拆掉相连关系边）
      await session.run(
        `
        // 定位待删文档
        MATCH (d:KnowledgeDocument {id: $id})
        // 可选匹配下属块：无 chunk 时仍可删文档
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
        // DETACH DELETE：先删节点上的所有关系，再删节点本身
        // 会清掉 HAS_CHUNK 等与 c/d 相连的边
        DETACH DELETE c, d
        `,
        { id: documentId },
      );
      // 孤儿实体清理：没有任何 chunk MENTIONS 的实体视为无引用，整节点删除
      await session.run(
        `
        MATCH (e:KnowledgeEntity)
        // 入边 MENTIONS 为空 ⇒ 已无任何文档块引用该实体
        WHERE NOT (e)<-[:MENTIONS]-()
        // DETACH 同时清掉 RELATED_TO 等残留关系，避免悬空边
        DETACH DELETE e
        `,
      );
      this.logger.log(`KG 图谱已删除：documentId=${documentId}`);
    } finally {
      await session.close();
    }
  }

  /**
   * 查询实体节点。Neo4j 不可用时返回 []。
   *
   * 只返回 KnowledgeEntity：文档块节点是内部结构，直接展示会把图炸成毛线团。
   * limit 钳在 [1,500]，防止前端一次拉全图。
   */
  async listNodes(type?: string, limit = 200, scope?: DocumentAccessScope) {
    if (!this.driver) {
      this.logger.warn('跳过图谱节点查询（Neo4j 不可用）');
      return [];
    }
    const cap = Math.min(Math.max(limit, 1), 500);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (e:KnowledgeEntity)
        WHERE ($type IS NULL OR $type = '' OR e.type = $type)
          AND (
            $unrestricted OR EXISTS {
              MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e)
              WHERE ${neo4jDocumentAccessWhere('d')}
            }
          )
        RETURN DISTINCT e.name AS id, e.name AS name, e.type AS type,
               e.description AS description
        LIMIT $limit
        `,
        { type: type ?? null, limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
        type: (record.get('type') as string) ?? null,
        description: (record.get('description') as string) ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱节点查询失败：${message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * 查询实体间 RELATED_TO 边。Neo4j 不可用时返回 []。
   *
   * 只取实体→实体的边，HAS_CHUNK / MENTIONS 属于文档内部结构，不对外展示。
   * weight 缺失时回落到 0.5，前端据此决定连线粗细。
   */
  async listEdges(limit = 500, scope?: DocumentAccessScope) {
    if (!this.driver) {
      this.logger.warn('跳过图谱边查询（Neo4j 不可用）');
      return [];
    }
    const cap = Math.min(Math.max(limit, 1), 1000);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
        WHERE $unrestricted OR (
          EXISTS {
            MATCH (d1:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(a)
            WHERE ${neo4jDocumentAccessWhere('d1')}
          }
          AND EXISTS {
            MATCH (d2:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(b)
            WHERE ${neo4jDocumentAccessWhere('d2')}
          }
        )
        RETURN a.name AS source, b.name AS target,
               r.relation AS relation, r.weight AS weight
        LIMIT $limit
        `,
        { limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
      );
      return result.records.map((record) => ({
        source: record.get('source') as string,
        target: record.get('target') as string,
        relation: (record.get('relation') as string) ?? 'RELATED_TO',
        weight: this.toNumber(record.get('weight'), 0.5),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱边查询失败：${message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * 全景图：文档 + 被提及实体 + 标签，不含 chunk（块太碎，不适合画布）。
   * 文档→实体 为「提及」，实体→实体 为 RELATED_TO 上的 relation，文档→标签 为「标注」。
   */
  async getOverview(params: {
    keyword?: string;
    entityType?: string;
    from?: string;
    to?: string;
    docLimit?: number;
    scope?: DocumentAccessScope;
  }) {
    const empty = {
      nodes: [] as Array<{
        id: string;
        name: string;
        kind: 'document' | 'entity' | 'tag';
        type?: string | null;
        documentId?: string | null;
        updatedAt?: string | null;
        description?: string | null;
      }>,
      edges: [] as Array<{
        source: string;
        target: string;
        relation: string;
        kind: 'mentions' | 'related' | 'tagged';
      }>,
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        documentCount: 0,
        entityCount: 0,
        tagCount: 0,
        mentionCount: 0,
        relatedCount: 0,
        entityTypes: [] as Array<{ type: string; count: number }>,
      },
      topEntities: [] as Array<{ name: string; type: string | null; degree: number }>,
      recentNodes: [] as Array<{
        id: string;
        name: string;
        kind: string;
        updatedAt: string | null;
      }>,
    };

    if (!this.driver) {
      this.logger.warn('跳过图谱全景（Neo4j 不可用）');
      return empty;
    }

    const kw = params.keyword?.trim() ?? '';
    const entityType = params.entityType?.trim() || null;
    const from = params.from?.trim() || null;
    const to = params.to?.trim() || null;
    const docLimit = Math.min(Math.max(params.docLimit ?? 24, 1), 80);
    const vis = neo4jAccessParams(params.scope);
    const session = this.driver.session();

    try {
      // 全库统计：仅统计当前用户可见文档及其提及
      const statsResult = await session.run(
        `
        OPTIONAL MATCH (d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
        WITH count(d) AS documentCount
        OPTIONAL MATCH (d2:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d2')}
        WITH documentCount, count(DISTINCT e) AS entityCount
        OPTIONAL MATCH (a:KnowledgeEntity)-[rel:RELATED_TO]->(b:KnowledgeEntity)
        WHERE $unrestricted OR (
          EXISTS {
            MATCH (d3:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(a)
            WHERE ${neo4jDocumentAccessWhere('d3')}
          }
          AND EXISTS {
            MATCH (d4:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(b)
            WHERE ${neo4jDocumentAccessWhere('d4')}
          }
        )
        WITH documentCount, entityCount, count(rel) AS relatedCount
        OPTIONAL MATCH (d5:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e0:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d5')}
        RETURN documentCount, entityCount, relatedCount, count(e0) AS mentionCount
        `,
        vis,
      );
      const statsRow = statsResult.records[0];
      const documentCount = this.toNumber(statsRow?.get('documentCount'), 0);
      const entityCount = this.toNumber(statsRow?.get('entityCount'), 0);
      const relatedCount = this.toNumber(statsRow?.get('relatedCount'), 0);
      const mentionCount = this.toNumber(statsRow?.get('mentionCount'), 0);

      // 按实体 type 分组计数，供前端筛选
      const typeRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d')}
          AND e.type IS NOT NULL AND e.type <> ''
        RETURN e.type AS type, count(DISTINCT e) AS count
        ORDER BY count DESC
        `,
        vis,
      );
      const entityTypes = typeRows.records.map((record) => ({
        type: String(record.get('type')),
        count: this.toNumber(record.get('count'), 0),
      }));

      // 被文档块 MENTIONS 最多的 5 个实体（degree = 提及次数）
      const topRows = await session.run(
        `
        MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)<-[:HAS_CHUNK]-(d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
        RETURN e.name AS name, e.type AS type, count(*) AS degree
        ORDER BY degree DESC
        LIMIT 5
        `,
        vis,
      );
      const topEntities = topRows.records.map((record) => ({
        name: String(record.get('name')),
        type: (record.get('type') as string) ?? null,
        degree: this.toNumber(record.get('degree'), 0),
      }));

      // 最近更新的 8 篇文档（不受 keyword / 时间 / 类型过滤）
      const recentRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
        RETURN d.id AS id, d.title AS name, d.updatedAt AS updatedAt
        ORDER BY d.updatedAt DESC
        LIMIT 8
        `,
        vis,
      );
      const recentNodes = recentRows.records.map((record) => ({
        id: `doc:${record.get('id') as string}`,
        name: String(record.get('name') ?? ''),
        kind: 'document',
        updatedAt: (record.get('updatedAt') as string) ?? null,
      }));

      // 主查询：按标题/摘要/标签 + 时间筛文档，LIMIT 后挂上 MENTIONS 实体（可按 entityType 再筛）
      const docRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
          AND ($kw = '' OR toLower(coalesce(d.title, '')) CONTAINS toLower($kw)
              OR toLower(coalesce(d.summary, '')) CONTAINS toLower($kw)
              OR toLower(coalesce(d.tags, '')) CONTAINS toLower($kw))
          AND ($from IS NULL OR d.updatedAt >= $from)
          AND ($to IS NULL OR d.updatedAt <= $to)
        WITH d ORDER BY d.updatedAt DESC LIMIT $docLimit
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE $entityType IS NULL OR e.type = $entityType
        RETURN d.id AS docId, d.title AS docTitle, d.summary AS summary,
               d.tags AS tags, d.updatedAt AS updatedAt,
               collect(DISTINCT CASE WHEN e IS NULL THEN NULL ELSE {
                 name: e.name, type: e.type, description: e.description
               } END) AS entities
        `,
        {
          kw,
          entityType,
          from,
          to,
          docLimit: neo4j.int(docLimit),
          ...vis,
        },
      );

      const docRecords = [...docRows.records];

      // 关键词命中实体但标题未命中时，把提及该实体的文档补进来
      if (kw) {
        const extra = await session.run(
          `
          MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)<-[:HAS_CHUNK]-(d:KnowledgeDocument)
          WHERE ${neo4jDocumentAccessWhere('d')}
            AND (toLower(coalesce(e.name, '')) CONTAINS toLower($kw)
             OR toLower(coalesce(e.description, '')) CONTAINS toLower($kw))
          WITH DISTINCT d
          WHERE ($from IS NULL OR d.updatedAt >= $from)
            AND ($to IS NULL OR d.updatedAt <= $to)
          OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e2:KnowledgeEntity)
          WHERE $entityType IS NULL OR e2.type = $entityType
          RETURN d.id AS docId, d.title AS docTitle, d.summary AS summary,
                 d.tags AS tags, d.updatedAt AS updatedAt,
                 collect(DISTINCT CASE WHEN e2 IS NULL THEN NULL ELSE {
                   name: e2.name, type: e2.type, description: e2.description
                 } END) AS entities
          LIMIT $docLimit
          `,
          {
            kw,
            entityType,
            from,
            to,
            docLimit: neo4j.int(docLimit),
            ...vis,
          },
        );
        const seen = new Set(docRecords.map((r) => String(r.get('docId'))));
        for (const record of extra.records) {
          const id = String(record.get('docId'));
          if (!seen.has(id)) docRecords.push(record);
        }
      }

      const nodeMap = new Map<
        string,
        {
          id: string;
          name: string;
          kind: 'document' | 'entity' | 'tag';
          type?: string | null;
          documentId?: string | null;
          updatedAt?: string | null;
          description?: string | null;
        }
      >();
      const edgeMap = new Map<
        string,
        {
          source: string;
          target: string;
          relation: string;
          kind: 'mentions' | 'related' | 'tagged';
        }
      >();
      const entityNames = new Set<string>();

      const addEdge = (
        source: string,
        target: string,
        relation: string,
        kind: 'mentions' | 'related' | 'tagged',
      ) => {
        const key = `${kind}|${source}|${target}|${relation}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { source, target, relation, kind });
        }
      };

      const splitTags = (raw: unknown) =>
        String(raw ?? '')
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);

      for (const record of docRecords) {
        const docId = String(record.get('docId'));
        const docNodeId = `doc:${docId}`;
        nodeMap.set(docNodeId, {
          id: docNodeId,
          name: String(record.get('docTitle') ?? ''),
          kind: 'document',
          type: 'DOCUMENT',
          documentId: docId,
          updatedAt: (record.get('updatedAt') as string) ?? null,
          description: (record.get('summary') as string) ?? null,
        });
        for (const tag of splitTags(record.get('tags'))) {
          const tagId = `tag:${tag}`;
          nodeMap.set(tagId, {
            id: tagId,
            name: tag,
            kind: 'tag',
            type: 'TAG',
          });
          addEdge(docNodeId, tagId, '标注', 'tagged');
        }
        const entities = record.get('entities') as Array<{
          name?: string;
          type?: string;
          description?: string;
        } | null>;
        for (const entity of entities ?? []) {
          if (!entity?.name) continue;
          const entityId = `entity:${entity.name}`;
          entityNames.add(entity.name);
          nodeMap.set(entityId, {
            id: entityId,
            name: entity.name,
            kind: 'entity',
            type: entity.type ?? 'CONCEPT',
            description: entity.description ?? null,
          });
          addEdge(docNodeId, entityId, '提及', 'mentions');
        }
      }

      if (entityNames.size > 0) {
        // 只取当前画布上实体之间的 RELATED_TO，避免拉全库关系
        const relatedRows = await session.run(
          `
          MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
          WHERE a.name IN $names AND b.name IN $names
          RETURN a.name AS source, b.name AS target,
                 r.relation AS relation, r.weight AS weight
          LIMIT 400
          `,
          { names: [...entityNames] },
        );
        for (const record of relatedRows.records) {
          const source = `entity:${record.get('source') as string}`;
          const target = `entity:${record.get('target') as string}`;
          const relation = (record.get('relation') as string) || '关联';
          addEdge(source, target, relation, 'related');
        }
      }

      const nodes = [...nodeMap.values()];
      const edges = [...edgeMap.values()];
      const tagCount = nodes.filter((n) => n.kind === 'tag').length;

      return {
        nodes,
        edges,
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          documentCount,
          entityCount,
          tagCount,
          mentionCount,
          relatedCount,
          entityTypes,
        },
        topEntities,
        recentNodes,
        entityTypes: entityTypes.map((t) => t.type),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱全景查询失败：${message}`);
      return empty;
    } finally {
      await session.close();
    }
  }

  private toNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (neo4j.isInt(value)) return value.toNumber();
    return fallback;
  }

  /**
   * 图谱关键词检索：匹配实体名/描述、文档标题/摘要、块标题/正文。
   * Neo4j 不可用或关键词为空时返回 []。
   *
   * 这里没有限定 label，一张图里三类节点（Entity / Document / Chunk）一起被扫，
   * 靠多字段 OR 覆盖它们各自的字段名；图规模大了应该改成按类型分开查 + 全文索引。
   */
  async searchGraph(keyword: string, limit = 50, scope?: DocumentAccessScope) {
    if (!this.driver) {
      this.logger.warn('跳过图谱检索（Neo4j 不可用）');
      return [];
    }
    const kw = keyword.trim();
    if (!kw) return [];

    const cap = Math.min(Math.max(limit, 1), 200);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (n)
        WHERE (
             toLower(coalesce(n.name, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.title, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.heading, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.description, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.summary, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.content, '')) CONTAINS toLower($kw)
        )
        AND (
          $unrestricted
          OR (n:KnowledgeDocument AND ${neo4jDocumentAccessWhere('n')})
          OR (n:DocumentChunk AND EXISTS {
            MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(n)
            WHERE ${neo4jDocumentAccessWhere('d')}
          })
          OR (n:KnowledgeEntity AND EXISTS {
            MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(n)
            WHERE ${neo4jDocumentAccessWhere('d')}
          })
        )
        RETURN labels(n)[0] AS label,
               coalesce(n.name, n.title, n.heading, n.id, n.chunkId) AS name,
               coalesce(n.id, n.chunkId, n.name) AS id,
               n.type AS type,
               n.title AS title,
               n.description AS description,
               n.heading AS heading,
               n.documentId AS documentId,
               n.summary AS summary,
               CASE
                 WHEN n.content IS NULL THEN null
                 ELSE substring(n.content, 0, 160)
               END AS snippet
        ORDER BY label, name
        LIMIT $limit
        `,
        { kw, limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
        label: (record.get('label') as string) ?? null,
        type: (record.get('type') as string) ?? null,
        title: (record.get('title') as string) ?? null,
        description: (record.get('description') as string) ?? null,
        heading: (record.get('heading') as string) ?? null,
        documentId: (record.get('documentId') as string) ?? null,
        summary: (record.get('summary') as string) ?? null,
        snippet: (record.get('snippet') as string) ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱检索失败：${message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * 把抽取结果写入 Neo4j：
   * - KnowledgeEntity（按 name MERGE，跨文档可复用同名实体）
   * - DocumentChunk -[:MENTIONS]-> Entity
   * - Entity -[:RELATED_TO]-> Entity
   *
   * 实体分 ON CREATE / ON MATCH：createdAt 只在首次写入，description 只有新值非空才覆盖，
   * 避免反复建图把更早的描述冲掉。chunkId 缺失时只建实体，不建 MENTIONS。
   */
  private async writeExtraction(
    session: Session,
    result: {
      chunkId?: string;
      entities: Array<{
        name: string;
        type: string;
        description?: string;
        aliases?: string[];
      }>;
      relations: Array<{
        source: string;
        target: string;
        relation: string;
        weight?: number;
      }>;
    },
  ): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const entity of result.entities) {
      await session.run(
        `
        MERGE (e:KnowledgeEntity {name: $name})
        ON CREATE SET e.type = $type, e.description = $description,
                      e.aliases = $aliases, e.createdAt = $now, e.updatedAt = $now
        ON MATCH SET e.type = coalesce($type, e.type),
                     e.description = CASE WHEN $description <> '' THEN $description ELSE e.description END,
                     e.updatedAt = $now
        `,
        {
          name: entity.name,
          type: entity.type,
          description: entity.description ?? '',
          aliases: entity.aliases ?? [],
          now,
        },
      );
      count++;

      if (result.chunkId) {
        await session.run(
          `
          MATCH (c:DocumentChunk {chunkId: $chunkId})
          MATCH (e:KnowledgeEntity {name: $name})
          MERGE (c)-[:MENTIONS]->(e)
          `,
          { chunkId: result.chunkId, name: entity.name },
        );
      }
    }

    // 关系两端的实体在上面已 MERGE 过；MATCH 不到端点时这条边会被静默丢弃（不报错），
    // 所以上游 ExtractionService 必须先过滤掉挂空实体的关系。
    for (const rel of result.relations) {
      await session.run(
        `
        MATCH (a:KnowledgeEntity {name: $source})
        MATCH (b:KnowledgeEntity {name: $target})
        MERGE (a)-[r:RELATED_TO]->(b)
        ON CREATE SET r.relation = $relType, r.weight = $weight, r.createdAt = datetime()
        ON MATCH SET r.weight = coalesce($weight, r.weight)
        `,
        {
          source: rel.source,
          target: rel.target,
          relType: rel.relation,
          weight: rel.weight ?? 0.5,
        },
      );
    }
    return count;
  }
}
