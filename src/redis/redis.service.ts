import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * Redis 客户端封装（ioredis）
 *
 * 职责：只提供 get / set(带 EX 过期) / del / ttl 四个操作，定位是「带 TTL 的键值缓存」，
 * 不是数据库也不做持久化业务状态，丢数据只影响性能不影响正确性。
 *
 * 关键依赖：ConfigService（REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB）。
 *
 * 坑与取舍：
 * 1. 故意不暴露 scan/keys/事务/发布订阅，避免业务把它当存储用；确需新命令时再按需开口子。
 * 2. set 不传 ttl 就是永久键，容易变成「缓存泄漏」，新代码尽量都带上过期时间。
 * 3. maxRetriesPerRequest=3：Redis 抖动时快速失败，不会把上游请求一起拖死。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    const password = this.config.get<string>('REDIS_PASSWORD');
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: password || undefined,
      db: this.config.get<number>('REDIS_DB', 0),
      maxRetriesPerRequest: 3,
    });
  }

  /** 读字符串值；键不存在返回 null（区分「没有」和「空串」） */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * 写字符串值。
   *
   * 传了 ttlSeconds 就走 SET ... EX 的单条原子命令，避免先 set 再 expire 之间进程挂掉留下永久键。
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, value);
  }

  /** 删除单个键；键不存在不算错误，调用方可安全重复调用 */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** 剩余存活秒数：-1 表示永不过期，-2 表示键不存在，调用方需要区分这两种情况 */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  /** 进程退出时 quit 掉连接，避免留下半开连接让 Redis 端堆积 */
  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
