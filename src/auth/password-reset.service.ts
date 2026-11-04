import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

const RESET_CODE_PREFIX = 'password:reset:code:';
export const RESET_CODE_TTL_SECONDS = 10 * 60;
export const RESET_CODE_COOLDOWN_SECONDS = 60;

/**
 * 密码重置验证码的 Redis 存取：key 固定为 password:reset:code:{email}，email 统一转小写后拼 key。
 *
 * 依赖 RedisService。
 *
 * 坑与取舍：
 * - TTL 600s（10 分钟）；发送冷却 60s 没有单独的 key，靠 getTtl 读剩余 TTL 判断：
 *   剩余 > 600 - 60 = 540s 即视为距上次发送不足 60s（见 AuthService.sendResetCode）。
 * - verify 只比对不删除，成功后由调用方 delete；失败也不清零，因此没有失败次数限制。
 * - key 小写归一化，同一邮箱大小写不同会命中同一条验证码。
 */
/** 密码重置验证码（Redis 存储） */
@Injectable()
export class PasswordResetService {
  constructor(private readonly redis: RedisService) {}

  private key(email: string): string {
    return `${RESET_CODE_PREFIX}${email.toLowerCase()}`;
  }

  async set(email: string, code: string): Promise<void> {
    await this.redis.set(this.key(email), code, RESET_CODE_TTL_SECONDS);
  }

  async get(email: string): Promise<string | null> {
    return this.redis.get(this.key(email));
  }

  /** 剩余秒数，沿用 Redis 原语语义：key 不存在返回 -2，无过期时间返回 -1 */
  async getTtl(email: string): Promise<number> {
    return this.redis.ttl(this.key(email));
  }

  async verify(email: string, code: string): Promise<boolean> {
    const stored = await this.get(email);
    return stored !== null && stored === code;
  }

  async delete(email: string): Promise<void> {
    await this.redis.del(this.key(email));
  }
}
