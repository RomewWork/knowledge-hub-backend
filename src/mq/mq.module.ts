import { Global, Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { DocumentPipelineConsumer } from './document-pipeline.consumer.js';
import { DocumentPipelinePublisher } from './document-pipeline.publisher.js';
import { RabbitMqService } from './rabbitmq.service.js';

/**
 * MQ 模块：组装 RabbitMQ 连接、管线生产者和消费者
 *
 * 职责：提供 RabbitMqService（连接/拓扑/发送）与 DocumentPipelinePublisher（业务侧触发入口）。
 *
 * 关键依赖：PipelineModule 提供 PipelineOrchestrator，消费者靠它真正执行 RAG / Search / KG 任务。
 *
 * 坑：
 * 1. 标了 @Global，所以其它模块不用再 import MqModule 就能注入 RabbitMqService 和 Publisher。
 * 2. DocumentPipelineConsumer 只放进 providers、不对外导出：它的作用是构造时注册 handler，不需要被注入。
 * 3. 消费者必须在构造器里注册 handler：Nest 先实例化全部 provider 再调 onModuleInit，
 *    这个时序保证注册早于 RabbitMqService 的 bindConsumers，别把它挪到生命周期钩子里。
 */
@Global()
@Module({
  imports: [PipelineModule],
  providers: [RabbitMqService, DocumentPipelinePublisher, DocumentPipelineConsumer],
  exports: [RabbitMqService, DocumentPipelinePublisher],
})
export class MqModule {}
