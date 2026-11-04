import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service.js';

const TOKEN_PREFIX = 'email:activation:token:';
const USER_PREFIX = 'email:activation:user:';
export const ACTIVATION_TOKEN_TTL_SECONDS = 24 * 3600;

/**
 * 邮箱激活令牌的 Redis 存取：token→userId 与 userId→token 双 key，24 小时后一起过期。
 *
 * 依赖 RedisService；只存 userId，邮箱与用户名由调用方（AuthService）传给邮件模板。
 *
 * 坑与取舍：
 * - 双 key 是刻意冗余：token key 让激活链接能反查用户，user key 让 createToken 能作废同一用户的旧 token。
 * - 重发会先按 userId 找到旧 token 并删除，旧链接立即失效（不是等 24h 自然过期）。
 * - consumeToken 读到即删（一次性），并发点两次只有一次能成功；发信失败时要 deleteByToken 成对回滚，
 *   否则会残留 userId→已删 token 的脏数据，导致下次重发逻辑失效。
 */
/** 邮箱激活令牌（Redis 存储，24 小时有效） */
@Injectable()
export class EmailActivationService {
  constructor(private readonly redis: RedisService) {}

  private tokenKey(token: string): string {
    return `${TOKEN_PREFIX}${token}`;
  }

  private userKey(userId: string): string {
    return `${USER_PREFIX}${userId}`;
  }

  /** 生成新 token；先作废该用户已有的旧 token，保证同一时刻只有一个有效链接 */
  async createToken(userId: string): Promise<string> {
    const existing = await this.redis.get(this.userKey(userId));
    if (existing) {
      await this.redis.del(this.tokenKey(existing));
    }

    const token = randomBytes(32).toString('hex');
    // token → userId：用户点激活链接时，用 token 查出要激活的账号
    await this.redis.set(this.tokenKey(token), userId, ACTIVATION_TOKEN_TTL_SECONDS);
    // userId → token：同一用户只保留一个有效 token，重发时先按 userId 找到并作废旧的
    await this.redis.set(this.userKey(userId), token, ACTIVATION_TOKEN_TTL_SECONDS);
    return token;
  }

  /** 校验并消费 token，返回 userId */
  async consumeToken(token: string): Promise<string | null> {
    const userId = await this.redis.get(this.tokenKey(token));
    if (!userId) return null;

    await this.redis.del(this.tokenKey(token));
    await this.redis.del(this.userKey(userId));
    return userId;
  }

  /** 按 token 反查并清掉两个 key，用于发信失败时回滚 */
  async deleteByToken(token: string): Promise<void> {
    const userId = await this.redis.get(this.tokenKey(token));
    await this.redis.del(this.tokenKey(token));
    if (userId) {
      await this.redis.del(this.userKey(userId));
    }
  }
}
