import { Client } from '@elastic/elasticsearch';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ES_DOC_VISIBILITY_FIELDS,
  esVisibilityFilter,
  type DocumentAccessScope,
} from '../document/document-access.js';

/** ES 文档级全文检索索引名 */
const ES_INDEX = 'kh_document';

/**
 * 文档级全文搜索索引（Elasticsearch kh_document）
 *
 * <p>与 RAG 向量索引的区别：</p>
 * - 这里是「整篇文档」一条记录（标题/摘要/全文），给关键词搜索列表用
 * - RAG 是「多块 + 向量」（kh_chunk），给后续对话检索预留
 *
 * <p>关键依赖：ConfigService（ELASTICSEARCH_NODE / ELASTICSEARCH_ENABLED），本类自建并持有 ES Client。</p>
 *
 * <p>坑与取舍：</p>
 * <p>- 写入用 ik_max_word（细切、召回全），检索用 ik_smart（粗切、query 不被切碎）；
 * 两个 analyzer 必须成对配置，只配一半会明显掉召回。</p>
 * <p>- ensureEsIndex 发现旧索引没配 IK 会直接删除重建：ES 的 analyzer 不能原地改，
 * 代价是索引里的历史文档全丢，必须重新发布（或用 BUILD_ALL 回填）。</p>
 * <p>- ES 不可用时写入/查询都只打日志：搜索退化为空结果，发布主流程照常走。</p>
 *
 * <p>仅写入 Elasticsearch `kh_document`；ES 不可用时跳过写入并打日志。</p>
 */
@Injectable()
export class SearchIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchIndexService.name);
  private es: Client | null = null;
  private readonly esEnabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.esEnabled = this.config.get<string>('ELASTICSEARCH_ENABLED', 'true') !== 'false';
  }

  /**
   * 启动时连 ES 并核对索引：拉一次集群健康 + 校验 mapping，属于一次性开销；
   * 任一步失败就把 es 置 null，后续写入/查询静默降级，不阻塞应用启动。
   */
  async onModuleInit() {
    if (!this.esEnabled) {
      this.logger.warn('Elasticsearch 已禁用，搜索索引将跳过写入');
      return;
    }

    const node = this.config.get('ELASTICSEARCH_NODE', 'http://localhost:9200');
    this.es = new Client({ node });
    try {
      const health = await this.es.cluster.health();
      this.logger.log(`SearchIndex ES 已连接：${node}, status=${health.status}`);
      await this.ensureEsIndex();
      await this.ensureVisibilityMapping();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Elasticsearch 不可用，搜索索引将跳过写入：${message}`);
      this.es = null;
    }
  }

  /** 关闭客户端连接（es 可能为 null，用可选链跳过） */
  async onModuleDestroy() {
    await this.es?.close();
  }

  /**
   * Upsert 一篇文档的搜索记录（含 Mongo 全文）。
   *
   * _id 用文档业务 id：重复发布是覆盖而不是新增，ES 里不会出现同一篇文档多条。
   * refresh: true 让写入立刻可被搜到，牺牲一点写入吞吐换「发布后马上搜得到」。
   */
  async indexDocument(doc: Record<string, unknown>) {
    if (!this.es) {
      this.logger.warn(`跳过搜索索引写入（ES 不可用）：documentId=${String(doc.id)}`);
      return;
    }

    const id = String(doc.id);
    await this.es.index({
      index: ES_INDEX,
      id,
      document: {
        ...doc,
        indexedAt: new Date().toISOString(),
      },
      refresh: true,
    });

    this.logger.log(`搜索索引已写入 ES：documentId=${id}`);
  }

  /** 已发布文档只改公开/团队时，补写可见性字段，不必整篇重索引 */
  async updateVisibility(
    documentId: string,
    vis: { isPublic: boolean; teamId: string | null; authorId: string | null },
  ) {
    if (!this.es) {
      this.logger.warn(`跳过搜索可见性更新（ES 不可用）：documentId=${documentId}`);
      return;
    }
    try {
      await this.es.update({
        index: ES_INDEX,
        id: documentId,
        doc: {
          isPublic: vis.isPublic,
          teamId: vis.teamId,
          authorId: vis.authorId,
        },
        refresh: true,
      });
      this.logger.log(`搜索索引可见性已更新：documentId=${documentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`搜索索引可见性更新失败：documentId=${documentId}, ${message}`);
    }
  }

  /** 下架 / 删除时从 ES 移除 */
  async deleteDocument(documentId: string) {
    if (!this.es) {
      this.logger.warn(`跳过搜索索引删除（ES 不可用）：documentId=${documentId}`);
      return;
    }

    try {
      await this.es.delete({
        index: ES_INDEX,
        id: documentId,
        refresh: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 文档从未进过索引 / 早被删掉时 ES 返回 404，属于正常情况，不当作失败告警
      if (!message.includes('404')) {
        this.logger.warn(`ES 删除失败：documentId=${documentId}, ${message}`);
      }
    }

    this.logger.log(`搜索索引已删除：documentId=${documentId}`);
  }

  /**
   * 关键词检索 kh_document。
   * ES 不可用时返回空分页，不抛错（搜索是旁路能力，缺了不该拖垮主流程）。
   *
   * pageSize 上限 50：ES 的 from + size 深分页很贵，够列表页用就行。
   */
  async searchDocuments(params: {
    keyword: string;
    page?: number;
    pageSize?: number;
    categoryId?: string;
    authorId?: string;
    scope?: DocumentAccessScope;
  }) {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 10, 50);
    const from = (page - 1) * pageSize;

    if (!this.es) {
      this.logger.warn('跳过搜索查询（ES 不可用）');
      return { items: [], total: 0, page, pageSize };
    }

    const filters: Record<string, unknown>[] = [];
    const vis = params.scope ? esVisibilityFilter(params.scope, ES_DOC_VISIBILITY_FIELDS) : null;
    if (vis) filters.push(vis);
    if (params.categoryId) {
      filters.push({ term: { categoryId: params.categoryId } });
    }
    if (params.authorId) {
      filters.push({ term: { authorId: params.authorId } });
    }

    const keyword = params.keyword.trim();
    // title^3 / summary^2：标题、摘要命中比正文权重大；filter 只筛不参与打分
    const query =
      filters.length > 0
        ? {
            bool: {
              must: [
                {
                  multi_match: {
                    query: keyword,
                    fields: ['title^3', 'summary^2', 'content'],
                    analyzer: 'ik_smart',
                  },
                },
              ],
              filter: filters,
            },
          }
        : {
            multi_match: {
              query: keyword,
              fields: ['title^3', 'summary^2', 'content'],
              analyzer: 'ik_smart',
            },
          };
    try {
      const response = await this.es.search({
        index: ES_INDEX,
        from,
        size: pageSize,
        query,
        // 列表不回传全文，仍用 content 做匹配与高亮
        _source: {
          excludes: ['content'],
        },
        // 命中片段打 <em>，给前端做摘要；正文最多 3 段、标题整段不高亮切片
        highlight: {
          fields: {
            title: { number_of_fragments: 0 },
            content: { fragment_size: 160, number_of_fragments: 3 },
            summary: { fragment_size: 120, number_of_fragments: 1 },
          },
        },
      });

      const totalRaw = response.hits.total;
      const total = typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);

      const items = (response.hits.hits ?? []).map((hit) => {
        const src = (hit._source ?? {}) as Record<string, unknown>;
        const highlight = hit.highlight ?? {};
        return {
          id: String(src.id ?? hit._id),
          title: src.title ?? '',
          summary: src.summary ?? null,
          categoryId: src.categoryId ?? null,
          tags: src.tags ?? null,
          authorId: src.authorId ?? null,
          teamId: src.teamId ?? null,
          isPublic: src.isPublic ?? null,
          status: src.status ?? null,
          publishTime: src.publishTime ?? null,
          score: hit._score ?? 0,
          highlight: {
            title: highlight.title ?? [],
            summary: highlight.summary ?? [],
            content: highlight.content ?? [],
          },
        };
      });

      return { items, total, page, pageSize };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`搜索查询失败：${message}`);
      return { items: [], total: 0, page, pageSize };
    }
  }

  /** 中文：写入细切（ik_max_word），检索粗切（ik_smart） */
  private readonly ikText = {
    type: 'text' as const,
    analyzer: 'ik_max_word',
    search_analyzer: 'ik_smart',
  };

  /**
   * 索引不存在则创建；已有但未配 IK 则删掉重建（须重新发布文档）。
   *
   * 只抽查 title 一个字段：三个中文文本字段在同一份 mapping 里总是成对配置，抽查一个够用。
   * 删重建而不是报错退出，是为了让升级后第一次启动就能自愈，代价见文件头说明。
   */
  private async ensureEsIndex() {
    if (!this.es) return;
    const exists = await this.es.indices.exists({ index: ES_INDEX });
    if (exists) {
      const mapping = await this.es.indices.getMapping({ index: ES_INDEX });
      const title = mapping[ES_INDEX]?.mappings?.properties?.title as
        { analyzer?: string } | undefined;
      if (title?.analyzer === 'ik_max_word') {
        return;
      }
      this.logger.warn(`索引 ${ES_INDEX} 未使用 IK，将删除并重建（请重新发布文档）`);
      await this.es.indices.delete({ index: ES_INDEX });
    }

    await this.es.indices.create({
      index: ES_INDEX,
      mappings: {
        properties: {
          id: { type: 'keyword' },
          title: this.ikText,
          summary: this.ikText,
          content: this.ikText,
          tags: { type: 'keyword' },
          status: { type: 'integer' },
          categoryId: { type: 'keyword' },
          authorId: { type: 'keyword' },
          publishTime: { type: 'date' },
        },
      },
    });
    this.logger.log(`已创建 ES 索引：${ES_INDEX}（ik_max_word / ik_smart）`);
  }

  /** 已有索引补可见性字段（旧 mapping 没有 isPublic） */
  private async ensureVisibilityMapping() {
    if (!this.es) return;
    try {
      await this.es.indices.putMapping({
        index: ES_INDEX,
        properties: {
          isPublic: { type: 'boolean' },
          teamId: { type: 'keyword' },
          authorId: { type: 'keyword' },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`kh_document 可见性 mapping 更新失败：${message}`);
    }
  }
}
