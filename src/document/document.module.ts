import { Module } from '@nestjs/common';
import { DocumentService } from './document.service.js';
import { DocumentController } from './document.controller.js';
import { DocumentContent, DocumentContentSchema } from './schemas/document-content.schema.js';
import { MongooseModule } from '@nestjs/mongoose';
import { FileParserService } from './parser/file-parser.service.js';
import { DocumentReviewService } from './document-review.service.js';

/**
 * 文档域模块：装配文档控制器、文档服务、审核服务与正文解析服务。
 *
 * 关键依赖：
 * - MongooseModule.forFeature 注册 DocumentContent 模型（Mongo 正文，注入时按 name 匹配）；
 * - PG（TypeOrmModule）与 Mongoose 根连接在 AppModule 全局注册，故此处无需再 import；
 * - RustfsService、DocumentPipelinePublisher 分别来自 @Global 的 StorageModule / MqModule，
 *   同样不需要显式 import。
 *
 * 取舍：exports 里的服务会被其他域（检索、管道、团队等）复用，改签名前先查调用方。
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: DocumentContent.name, schema: DocumentContentSchema }]),
  ],
  controllers: [DocumentController],
  providers: [DocumentService, FileParserService, DocumentReviewService],
  exports: [DocumentService, FileParserService, DocumentReviewService],
})
export class DocumentModule {}
