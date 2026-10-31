import { Module } from '@nestjs/common';
import { DocumentService } from './document.service.js';
import { DocumentController } from './document.controller.js';
import { DocumentContent, DocumentContentSchema } from './schemas/document-content.schema.js';
import { MongooseModule } from '@nestjs/mongoose';
import { FileParserService } from './parser/file-parser.service.js';
import { DocumentReviewService } from './document-review.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DocumentContent.name, schema: DocumentContentSchema }]),
  ],
  controllers: [DocumentController],
  providers: [DocumentService, FileParserService, DocumentReviewService],
  exports: [DocumentService, FileParserService, DocumentReviewService],
})
export class DocumentModule {}
