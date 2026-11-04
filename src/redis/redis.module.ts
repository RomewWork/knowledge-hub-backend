import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Redis 模块
 *
 * 职责：创建 RedisService 并全局导出，让任意模块都能直接注入缓存客户端。
 *
 * 关键依赖：RedisService（内部自建 ioredis 连接）。
 *
 * 坑与取舍：
 * 1. 标了 @Global，全应用共用一个连接实例，不要在各业务模块里自己 new Redis，否则连接数会随模块数膨胀。
 * 2. 连接在 RedisService 构造时即建立，所以本模块导入就意味着启动时会连 Redis；本地没有 Redis 时需要先把它关掉/指到可用地址。
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
