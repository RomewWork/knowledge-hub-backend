import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentService } from './document.service.js';
import { DocumentReviewService } from './document-review.service.js';
import { DocumentController } from './document.controller.js';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema.js';
import { FileParserService } from './parser/file-parser.service.js';
import { MineruParser } from './parser/mineru.parser.js';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { CategoryService } from './category.service.js';
import { CategoryController } from './category.controller.js';
import { DocumentSocialService } from './document-social.service.js';
import { DocumentShareService } from './document-share.service.js';
import { DocumentVersionService } from './document-version.service.js';
import { ShareController } from './share.controller.js';
import {
  DocumentEngagementController,
  FavoriteController,
} from './document-engagement.controller.js';

/**
 * 文档模块
 * - DocumentService：文档 CRUD + 状态流转（草稿 / 发布 / 归档 / 待审核）
 * - DocumentReviewService：发布审核（提交 / 通过 / 驳回）
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    PipelineModule,
    NotificationModule,
  ],
  controllers: [
    DocumentController,
    CategoryController,
    ShareController,
    DocumentEngagementController,
    FavoriteController,
  ],
  providers: [
    DocumentService,
    DocumentReviewService,
    FileParserService,
    MineruParser,
    CategoryService,
    DocumentSocialService,
    DocumentShareService,
    DocumentVersionService,
  ],
  exports: [DocumentService, DocumentReviewService, FileParserService],
})
export class DocumentModule {}
