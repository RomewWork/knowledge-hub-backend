/**
 * 对话短期记忆：Redis 热窗口，只是加速层。
 *
 * 职责：
 * - 按会话缓存最近几轮 human/ai 原文，下一轮直接拼进 prompt，省一次 Postgres 回放。
 * - 读不到就返回 null 交给调用方回填，写失败也只是降速，不改变事实来源。
 *
 * 关键依赖：
 * - RedisService（../redis/redis.service.js），key 形如
 *   {prefix}:{userId}:{sessionId}:messages，默认前缀 kh:chat，TTL 24h、窗口 20 条。
 * - chat-memory.util.js 的 isWorkingMessage 做消息类型过滤。
 *
 * 坑：
 * - key 必须带 userId：只按 sessionId 建 key，换用户或多端复用会话时会把别人的对话串进来。
 * - 只存 human/ai 原文，system/tool 要在读写两侧都过滤，否则回放会污染本轮 prompt。
 * - tryLoad 无 key 或 Redis 异常时返回 null 而不是空数组，语义是「要去 PG 拿」；
 *   返回空数组会被上层误判成「这个会话真没有历史」。
 * - TTL 过期不丢历史，Postgres 才是事实源；所有 Redis 异常只 warn 不抛，
 *   缓存故障时问答必须照常降级。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { RedisService } from '../redis/redis.service.js';
import { isWorkingMessage } from './chat-memory.util.js';

/**
 * 对话短期记忆：Redis 热窗口。
 * miss / 故障时由调用方从 Postgres 回填再 save。
 * 只存 human/ai 原文，不含检索资料、思考、Mem0 系统消息。
 */
@Injectable()
export class ChatShortMemoryService {
  private readonly logger = new Logger(ChatShortMemoryService.name);
  private readonly ttlSeconds: number;
  private readonly maxMessages: number;
  private readonly keyPrefix: string;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.ttlSeconds = Number(config.get('CHAT_SHORT_MEMORY_TTL_SECONDS', 86400));
    this.maxMessages = Number(config.get('CHAT_SHORT_MEMORY_MAX_MESSAGES', 20));
    this.keyPrefix = config.get('CHAT_SHORT_MEMORY_KEY_PREFIX', 'kh:chat');
  }

  /** 供上层判断窗口大小，决定从 Postgres 回填多少条历史 */
  get windowSize() {
    return this.maxMessages;
  }

  /** 命中返回消息；key 不存在或 Redis 故障返回 null */
  async tryLoad(userId: string, sessionId: string): Promise<BaseMessage[] | null> {
    try {
      const raw = await this.redis.get(this.key(userId, sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      return mapStoredMessagesToChatMessages(parsed).filter(isWorkingMessage);
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 读取失败，改走数据库：${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * 写入前再过滤一次并截到窗口上限：调用方可能把整段历史传进来，
   * 只留最近 maxMessages 条即可；写失败只 warn，缓存写不进去不影响本轮回答。
   */
  async save(userId: string, sessionId: string, messages: BaseMessage[]): Promise<void> {
    const working = messages.filter(isWorkingMessage).slice(-this.maxMessages);
    try {
      const payload = JSON.stringify(mapChatMessagesToStoredMessages(working));
      await this.redis.set(this.key(userId, sessionId), payload, this.ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 写入失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * 把本轮问答接在历史后面整体重写，而不是追加单条：
   * 窗口裁剪只发生在 save 一处，Redis 里永远是最近 N 条，不会越积越长。
   */
  async appendTurn(
    userId: string,
    sessionId: string,
    history: BaseMessage[],
    question: string,
    answer: string,
  ): Promise<void> {
    await this.save(userId, sessionId, [
      ...history,
      new HumanMessage(question),
      new AIMessage(answer),
    ]);
  }

  /** 用户主动清空会话时同步删缓存，否则下一轮还会从 Redis 里把旧对话放出来 */
  async clear(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId, sessionId));
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 删除失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** key 里必须带 userId，防止不同用户复用同一个 sessionId 时互相串号 */
  private key(userId: string, sessionId: string) {
    return `${this.keyPrefix}:${userId}:${sessionId}:messages`;
  }
}
