import { Global, Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { DocumentPipelineConsumer } from './document-pipeline.consumer.js';
import { DocumentPipelinePublisher } from './document-pipeline.publisher.js';
import { RabbitMqService } from './rabbitmq.service.js';

@Global()
@Module({
  imports: [PipelineModule],
  providers: [RabbitMqService, DocumentPipelinePublisher, DocumentPipelineConsumer],
  exports: [RabbitMqService, DocumentPipelinePublisher],
})
export class MqModule {}
