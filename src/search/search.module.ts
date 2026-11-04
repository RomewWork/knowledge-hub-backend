import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { SearchController } from './search.controller.js';

/**
 * 全文检索模块
 *
 * 只注册 Controller，不在这里重复声明 SearchIndexService：
 * 写入索引（消费 MQ）与读取索引（本接口）共用同一个 ES 客户端，
 * 该 service 归属 PipelineModule，通过 imports 复用，避免出现两个 ES 连接。
 *
 * 注意：模块类必须加 @Module 装饰器。漏写不会导致编译报错，
 * 但控制器不会被注册，表现就是接口一直 404。
 */
@Module({
  imports: [PipelineModule],
  controllers: [SearchController],
})
export class SearchModule {}
