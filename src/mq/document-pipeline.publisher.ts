import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DocumentEntity } from '../document/entities/document.entity.js';
import {
  RAG_REINDEX_EXCHANGE,
  RAG_RK_BY_IDS,
  RAG_RK_DELETE,
  SEARCH_INDEX_EXCHANGE,
  SEARCH_RK_DELETE,
  SEARCH_RK_INDEX,
  KG_GRAPH_EXCHANGE,
  KG_RK_BUILD_BY_IDS,
  KG_RK_DELETE,
} from './mq.constans.js';
import {
  ReindexMessage,
  SearchIndexMessage,
  KgBuildMessage,
} from './message/pipeline.messagets.js';
import { RabbitMqService } from './rabbitmq.service.js';

/**
 * 文档发布后的知识管线「生产者」
 *
 * <p>触发：RAG 向量化。</p>
 * <p>约定：投递失败只打日志，<b>不回滚</b>文档已发布状态。</p>
 *
 * <p>关键依赖：{@link RabbitMqService}。</p>
 * <p>坑：三条管线（RAG / Search / KG）互不等待对方成功，任一投递失败都不会补偿，
 * 索引与库内状态可能短暂不一致，只能靠下游按文档 ID 全量重建来兜底。</p>
 */
@Injectable()
export class DocumentPipelinePublisher {
  private readonly logger = new Logger(DocumentPipelinePublisher.name);

  constructor(private readonly rabbit: RabbitMqService) {}

  /**
   * 发布成功后调用：并行投递 RAG / Search / KG。
   *
   * 用 Promise.all 把三条消息一起投出，避免三次网络往返串行叠加拖慢发布接口。
   * 注意：数组元素带 await，当前实际仍是串行；若要真并发，应传入未 await 的 Promise。
   */
  async afterPublish(document: DocumentEntity) {
    await Promise.all([
      await this.triggerRagReindex(document.id),
      await this.triggerSearchIndex(document.id),
      await this.triggerKgBuild(document.id),
    ]);
  }

  /** 归档/删除后：通知 RAG / Search / KG按文档 ID 清理索引 */
  async afterUnpublish(documentId: string) {
    await Promise.all([
      this.triggerRagDelete(documentId),
      this.triggerSearchDelete(documentId),
      this.triggerKgDelete(documentId),
    ]);
  }

  /** RAG：按文档 ID 重建向量块 */
  private async triggerRagReindex(documentId: string) {
    const message: ReindexMessage = {
      taskId: randomUUID(),
      type: 'BY_DOC_IDS',
      documentIds: [documentId],
    };

    const ok = await this.rabbit.publish(RAG_REINDEX_EXCHANGE, RAG_RK_BY_IDS, message);
    this.logger.log(
      `RAG 重建索引${ok ? '已投递' : '投递失败'}：documentId=${documentId}, taskId=${message.taskId}`,
    );
  }

  /** RAG：文档归档/删除后按 ID 清掉对应向量块，避免检索到已下线内容 */
  private async triggerRagDelete(documentId: string) {
    const message: ReindexMessage = {
      taskId: randomUUID(),
      type: 'DELETE_BY_DOC_IDS',
      documentIds: [documentId],
    };
    await this.rabbit.publish(RAG_REINDEX_EXCHANGE, RAG_RK_DELETE, message);
  }

  /** Search：删掉 kh_document 里该文档的检索记录 */
  private async triggerSearchDelete(documentId: string) {
    const message: SearchIndexMessage = {
      taskId: randomUUID(),
      type: 'DELETE',
      documentId,
    };
    await this.rabbit.publish(SEARCH_INDEX_EXCHANGE, SEARCH_RK_DELETE, message);
  }

  /**
   * Search：消息内直接带文档快照，消费者无需再查库也能写索引。
   * content 只截前 1000 字，控制消息体积。
   *
   * 注意：v10 起消息体只带 documentId，不再携带快照，消费者需自行查库补齐字段。
   */
  private async triggerSearchIndex(documentId: string) {
    const message: SearchIndexMessage = {
      taskId: randomUUID(),
      type: 'INDEX',
      documentId,
    };
    const ok = await this.rabbit.publish(SEARCH_INDEX_EXCHANGE, SEARCH_RK_INDEX, message);
    this.logger.log(
      `ES 搜索索引${ok ? '已投递' : '投递失败'}：documentId=${documentId}, taskId=${message.taskId}`,
    );
  }

  /** KG：按文档 ID 建图谱 */
  private async triggerKgBuild(documentId: string) {
    const message: KgBuildMessage = {
      taskId: randomUUID(),
      type: 'BUILD_BY_DOC_IDS',
      documentIds: [documentId],
    };

    const ok = await this.rabbit.publish(KG_GRAPH_EXCHANGE, KG_RK_BUILD_BY_IDS, message);
    this.logger.log(
      `KG 建图${ok ? '已投递' : '投递失败'}：documentId=${documentId}, taskId=${message.taskId}`,
    );
  }

  /** KG：删掉该文档贡献的实体关系，避免图谱里残留已归档内容 */
  private async triggerKgDelete(documentId: string) {
    const message: KgBuildMessage = {
      taskId: randomUUID(),
      type: 'DELETE_BY_DOC_IDS',
      documentIds: [documentId],
    };
    await this.rabbit.publish(KG_GRAPH_EXCHANGE, KG_RK_DELETE, message);
  }
}
