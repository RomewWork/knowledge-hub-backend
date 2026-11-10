import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { AiChatService } from './ai-chat.service.js';
import { AiStreamService } from './ai-stream.service.js';
import { AiController } from './ai.controller.js';
import { ChatSessionService } from './chat-session.service.js';
import { HybridRetrievalService } from './hybrid-retrieval.service.js';
import { RerankerService } from './reranker.service.js';
import { WebSearchService } from './web-search.service.js';

/**
 * RAG 模块
 *
 * 依赖 PipelineModule：复用 EmbeddingService（查 query 向量）与 VectorIndexService
 * （kh_chunk 的关键词 / kNN / RRF 融合），不为检索另建一套 ES 客户端。
 *
 * providers 三个 service 分层清晰：
 * HybridRetrievalService 管编排与降级，RerankerService 管精排（失败返回 null），
 * AiChatService 管生成与引用解析。
 */
@Module({
  imports: [PipelineModule],
  controllers: [AiController],
  providers: [
    AiChatService,
    AiStreamService,
    ChatSessionService,
    HybridRetrievalService,
    RerankerService,
    WebSearchService,
  ],
})
export class AiModule {}
