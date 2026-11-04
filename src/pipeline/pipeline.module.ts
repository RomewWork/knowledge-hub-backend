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
import { SearchIndexService } from './search-index.service.js';
import { ExtractionService } from './extraction.service.js';
import { GraphBuildService } from './graph-build.service.js';

/**
 * 索引流水线模块（pipeline 域的装配点）
 *
 * <p>把「分块 → 向量 → 搜索索引 → 图谱抽取」链路上的 service 收在一个模块里，
 * 供 MqModule（发布后消费）以及 SearchModule / GraphModule（查询侧）imports 复用，
 * 避免同一个 ES / Neo4j 连接被不同模块各建一份。</p>
 *
 * <p>关键依赖：MongooseModule.forFeature 注册 DocumentContent，供编排器回查 Mongo 正文；
 * Postgres 的 EntityManager 由 app.module 的 TypeOrmModule.forRootAsync 全局提供，此处无需再导入。</p>
 *
 * <p>坑与取舍：</p>
 * <p>- ES / Neo4j 的连接在各自 service 的 onModuleInit 里自建，本模块不统一管客户端生命周期；
 * onModuleDestroy 的关闭逻辑也必须跟着各 service 写，新增 provider 时别漏。</p>
 * <p>- 只在 exports 里放「会被别的模块直接调用的服务」，ChunkingService / ExtractionService
 * 属于流水线内部实现，外部拿不到，也就不会绕过编排器乱跑。</p>
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: DocumentContent.name, schema: DocumentContentSchema }]),
  ],
  providers: [
    ChunkingService,
    EmbeddingService,
    VectorIndexService,
    SearchIndexService,
    ExtractionService,
    GraphBuildService,
    PipelineOrchestrator,
  ],
  exports: [
    PipelineOrchestrator,
    VectorIndexService,
    SearchIndexService,
    GraphBuildService,
    EmbeddingService,
  ],
})
export class PipelineModule {}
