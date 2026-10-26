import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DocumentContent,
  DocumentContentSchema,
} from '../document/schemas/document-content.schema.js';
import { ChunkingService } from './chunking.service.js';
import { EmbeddingService } from './embedding.service.js';
import { PipelineOrchestrator } from './pipeline.orchestrator.js';
import { VectorIndexService } from './vector-index.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DocumentContent.name, schema: DocumentContentSchema }]),
  ],
  providers: [ChunkingService, EmbeddingService, VectorIndexService, PipelineOrchestrator],
  exports: [PipelineOrchestrator, VectorIndexService],
})
export class PipelineModule {}
