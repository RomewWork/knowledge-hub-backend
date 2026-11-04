import { Injectable, Logger } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import { PipelineOrchestrator } from '../pipeline/pipeline.orchestrator.js';
import { RAG_REINDEX_QUEUE, SEARCH_INDEX_QUEUE, KG_GRAPH_QUEUE } from './mq.constans.js';
import {
  ReindexMessage,
  SearchIndexMessage,
  KgBuildMessage,
} from './message/pipeline.messagets.js';
import { RabbitMqService } from './rabbitmq.service.js';

/**
 * 文档发布后管线的 MQ 消费者
 *
 * <p>消费：RAG 向量化 + Search 全文索引 + KG 建图。</p>
 * <p>注册时机：在构造函数里 `registerHandler`，</p>
 * 保证早于 {@link RabbitMqService.onModuleInit} 的 `bindConsumers`。
 *
 * <p>关键依赖：{@link RabbitMqService}（注册与生命周期）、PipelineOrchestrator（真正的业务实现）。</p>
 * <p>坑 1：registerHandler 必须在构造器里做，挪到 onModuleInit 会因 Nest 先初始化 RabbitMqService
 * 而错过 bindConsumers 那一轮，表现为队列有人投递但永远没消费者。</p>
 * <p>坑 2：这里只做反序列化和转发，异常一律往上抛给 RabbitMqService 统一 nack，
 * 不要自己 try/catch 吞掉，否则消息会被当成消费成功。</p>
 */
@Injectable()
export class DocumentPipelineConsumer {
  private readonly logger = new Logger(DocumentPipelineConsumer.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly orchestrator: PipelineOrchestrator,
  ) {
    this.rabbit.registerHandler(RAG_REINDEX_QUEUE, (msg) => this.handleRag(msg));
    this.rabbit.registerHandler(SEARCH_INDEX_QUEUE, (msg) => this.handleSearch(msg));
    this.rabbit.registerHandler(KG_GRAPH_QUEUE, (msg) => this.handleKg(msg));
  }

  /** RAG：分块 → 向量化 → ES kh_chunk（dense_vector） */
  private async handleRag(msg: ConsumeMessage) {
    const body = this.parseJson<ReindexMessage>(msg);
    this.logger.log(
      `[RAG] type=${body.type}, taskId=${body.taskId}, documentIds=${JSON.stringify(body.documentIds ?? [])}`,
    );
    await this.orchestrator.handleRagReindex(body.type, body.documentIds);
  }

  /** Search：文档级关键词索引（Elasticsearch kh_document） */
  private async handleSearch(msg: ConsumeMessage) {
    const body = this.parseJson<SearchIndexMessage>(msg);
    this.logger.log(
      `[Search] type=${body.type}, taskId=${body.taskId}, documentId=${body.documentId}`,
    );

    await this.orchestrator.handleSearchIndex(body.type, body.documentId);
  }

  /** KG：分块 → 抽实体关系 → Neo4j */
  private async handleKg(msg: ConsumeMessage) {
    const body = this.parseJson<KgBuildMessage>(msg);
    this.logger.log(
      `[KG] type=${body.type}, taskId=${body.taskId}, documentIds=${JSON.stringify(body.documentIds ?? [])}`,
    );
    await this.orchestrator.handleKgBuild(body.type, body.documentIds);
  }

  /** 统一从消息体解析 JSON，格式不对时直接抛错走 nack，不做兜底 */
  private parseJson<T>(msg: ConsumeMessage): T {
    return JSON.parse(msg.content.toString('utf8')) as T;
  }
}
