/**
 * AI 模块：RAG 问答的依赖装配入口。
 *
 * 职责：把生成（AiChatService / AiStreamService）、会话、记忆与检索各层组装成一个模块，
 * 由 AiController 对外暴露；本文件只做装配，不放业务逻辑。
 *
 * 关键依赖：
 * - PipelineModule：复用 EmbeddingService 与 VectorIndexService，检索链路不再自建客户端。
 * - 记忆与改写 service 的 Redis / Mem0 / LLM 客户端都在各自构造体内按配置创建或注入，
 *   本模块不额外 import 这些基础模块，避免出现第二套客户端实例。
 *
 * 坑：
 * - 三个记忆 provider 必须同时注册：AiChatService 注入不到会在启动期直接报
 *   Nest can't resolve dependencies，而不是等到请求时才失败。
 * - 记忆与改写都是可选能力，缺 MEM0_API_KEY / LLM key 时由 service 内部降级为空实现，
 *   不能在模块装配阶段抛错，否则整个服务起不来。
 */

import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { AiChatService } from './ai-chat.service.js';
import { AiStreamService } from './ai-stream.service.js';
import { AiController } from './ai.controller.js';
import { ChatSessionService } from './chat-session.service.js';
import { HybridRetrievalService } from './hybrid-retrieval.service.js';
import { RerankerService } from './reranker.service.js';
import { WebSearchService } from './web-search.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import { ChatQueryRewriteService } from './chat-query-rewrite.service.js';

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
    // 短期记忆：Redis 热窗口，缓存最近几轮 human/ai 原文，减少 Postgres 回放
    ChatShortMemoryService,
    // 长期记忆：Mem0 的 user / session 两层记忆读写，未配 MEM0_API_KEY 时自动禁用
    ChatLongMemoryService,
    // 检索改写：把追问改写成可独立检索的短查询，并判断是否需要查库
    ChatQueryRewriteService,
    HybridRetrievalService,
    RerankerService,
    WebSearchService,
  ],
})
export class AiModule {}
