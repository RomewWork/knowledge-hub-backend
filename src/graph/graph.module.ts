import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { GraphController } from './graph.controller.js';

/**
 * 图谱查询模块
 *
 * 依赖 PipelineModule 导出的 GraphBuildService（建图 + 查图在同一 service 里），
 * 这样只需要维护一个 Neo4j driver 的声明与销毁。
 */
@Module({
  imports: [PipelineModule],
  controllers: [GraphController],
})
export class GraphModule {}
