import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import amqp, { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  KG_GRAPH_EXCHANGE,
  KG_GRAPH_QUEUE,
  KG_RK_BUILD_BY_IDS,
  KG_RK_DELETE,
  RAG_REINDEX_EXCHANGE,
  RAG_REINDEX_QUEUE,
  RAG_RK_BY_IDS,
  RAG_RK_DELETE,
  SEARCH_INDEX_EXCHANGE,
  SEARCH_INDEX_QUEUE,
  SEARCH_RK_DELETE,
  SEARCH_RK_INDEX,
} from './mq.constans.js';

/** 消费回调签名：抛异常即视为消费失败，由 bindConsumers 统一 nack */
export type MessageHandler = (msg: ConsumeMessage) => Promise<void> | void;

/**
 * RabbitMQ 连接与拓扑门面（基于 amqp-connection-manager 封装）
 *
 * 职责：建立可自动重连的连接，在 channel setup 阶段声明 RAG / Search / KG 三套拓扑，
 * 按队列注册消费者，并对外提供 publish 发送能力。
 *
 * 关键依赖：ConfigService（RABBITMQ_URL / RABBITMQ_ENABLED / RABBITMQ_CONNECT_TIMEOUT_MS）、amqplib。
 *
 * 坑与取舍：
 * 1. assertTopology 必须声明全部链路（RAG / Search / KG）的 exchange + queue + binding。
 *    漏声明时 producer 侧往往无感知，但消费者 consume 会因队列不存在报 404 NOT_FOUND 并崩溃。
 * 2. 消费失败只 nack（不 ack、不重新入队），历史遗留行为：失败消息不会自动重试，只能靠日志发现后人工重投。
 * 3. RABBITMQ_ENABLED=false 时整体跳过：不建连、publish 返回 false，保证本机没有 MQ 也能启动服务。
 */
@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;
  private readonly enabled: boolean;
  private readonly handlers = new Map<string, MessageHandler>();

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<string>('RABBITMQ_ENABLED', 'true') !== 'false';
  }

  /** 供上层判断是否值得组织消息体；关掉 MQ 时业务应跳过管线触发 */
  get isEnabled() {
    return this.enabled;
  }

  /**
   * 启动时建连并等待 channel 就绪。
   *
   * 连接失败会直接抛错中断启动（而不是降级为「假可用」），
   * 否则应用能起来但消息一直静默发不出去，问题会被拖到很久以后才暴露。
   */
  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('RabbitMQ 已禁用（RABBITMQ_ENABLED=false）');
      return;
    }

    const url = this.config.get<string>('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672');
    const safeUrl = this.redactAmqpUrl(url);
    const timeoutMs = Number(this.config.get<string>('RABBITMQ_CONNECT_TIMEOUT_MS', '15000'));

    this.logger.log(`正在连接 RabbitMQ：${safeUrl}（超时 ${timeoutMs}ms）`);

    this.connection = amqp.connect([url]);
    const connectionEvents = this.connection as unknown as EventEmitter;
    connectionEvents.on('connect', (arg) => {
      const connectedUrl =
        typeof arg === 'object' && arg && 'url' in arg
          ? String((arg as { url?: string }).url ?? url)
          : url;
      this.logger.log(`RabbitMQ 已连接：${this.redactAmqpUrl(connectedUrl)}`);
    });

    connectionEvents.on('disconnect', (err) =>
      this.logger.warn(`RabbitMQ 断开：${this.errorMessage(err?.err ?? err)}`),
    );

    connectionEvents.on('connectFailed', (err) =>
      this.logger.error(
        `RabbitMQ 连接失败：${this.errorMessage(err?.err ?? err)}（url=${safeUrl}）`,
      ),
    );

    // setup 在每次（重）连上都执行一遍，所以拓扑声明与消费绑定放这里，
    // broker 重启或队列被误删后能自动补齐，不用手动干预。
    this.channel = this.connection.createChannel({
      json: true,
      setup: async (ch: ConfirmChannel) => {
        this.logger.log('RabbitMQ channel setup：声明拓扑并绑定消费者');
        await this.assertTopology(ch);
        await this.bindConsumers(ch);
      },
    });

    // waitForConnect 自身不设上限，这里加超时兜底，避免 broker 不可达时启动流程一直挂着
    try {
      await Promise.race([
        this.channel.waitForConnect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `RabbitMQ 连接超时（${timeoutMs}ms）：${safeUrl}。请检查服务是否启动、5672 是否被其他容器占用、账号密码是否正确`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      this.logger.log('RabbitMQ channel 就绪');
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`RabbitMQ 初始化失败：${message}`);
      await this.connection.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      throw error;
    }
  }

  /** 日志里隐藏 AMQP 密码 */
  private redactAmqpUrl(url: string) {
    return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
  }

  /** amqplib 的异常有的是 Error 有的是裸对象，统一取出可读文本再打日志 */
  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (
      typeof error === 'object' &&
      error &&
      'message' in error &&
      typeof (error as { message: unknown }).message === 'string'
    ) {
      return (error as { message: string }).message;
    }
    return String(error ?? 'unknown');
  }

  /** 停机时先关 channel 再关连接，避免重连定时器继续在后台拉起连接 */
  async onModuleDestroy() {
    await this.channel?.close();
    await this.connection?.close();
  }

  /** 注册队列消费者（在模块 init 前/后均可；连接就绪后生效） */
  registerHandler(queue: string, handler: MessageHandler) {
    this.handlers.set(queue, handler);
  }

  /**
   * 发送消息。
   *
   * 失败只返回 false 而不抛异常：调用方多半是「发布成功后触发管线」这类旁路逻辑，
   * 不应该因为 MQ 抖动把已经成功的业务操作判成失败。
   * persistent=true 让消息落盘，broker 重启后不会丢。
   */
  async publish(exchange: string, routingKey: string, payload: unknown): Promise<boolean> {
    if (!this.enabled || !this.channel) {
      this.logger.warn(`跳过发消息（MQ 不可用）：exchange=${exchange}, rk=${routingKey}`);
      return false;
    }

    try {
      await this.channel.publish(exchange, routingKey, payload, {
        contentType: 'application/json',
        persistent: true,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`发消息失败：exchange=${exchange}, rk=${routingKey}, error=${message}`);
      return false;
    }
  }

  /**
   * 声明全部链路拓扑（RAG / Search / KG），幂等：每次 setup 都会执行一遍。
   *
   * 必须在这里把每条链路的 exchange、queue、binding 全部声明齐。
   * 只声明了 exchange 或漏了 binding，消费者侧 consume 会因队列不存在抛 404 NOT_FOUND 并直接崩溃。
   */
  private async assertTopology(ch: ConfirmChannel) {
    await ch.assertExchange(RAG_REINDEX_EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(RAG_REINDEX_QUEUE, { durable: true });
    await ch.bindQueue(RAG_REINDEX_QUEUE, RAG_REINDEX_EXCHANGE, RAG_RK_BY_IDS);
    await ch.bindQueue(RAG_REINDEX_QUEUE, RAG_REINDEX_EXCHANGE, RAG_RK_DELETE);

    await ch.assertExchange(SEARCH_INDEX_EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(SEARCH_INDEX_QUEUE, { durable: true });
    await ch.bindQueue(SEARCH_INDEX_QUEUE, SEARCH_INDEX_EXCHANGE, SEARCH_RK_INDEX);
    await ch.bindQueue(SEARCH_INDEX_QUEUE, SEARCH_INDEX_EXCHANGE, SEARCH_RK_DELETE);

    await ch.assertExchange(KG_GRAPH_EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(KG_GRAPH_QUEUE, { durable: true });
    await ch.bindQueue(KG_GRAPH_QUEUE, KG_GRAPH_EXCHANGE, KG_RK_BUILD_BY_IDS);
    await ch.bindQueue(KG_GRAPH_QUEUE, KG_GRAPH_EXCHANGE, KG_RK_DELETE);

    this.logger.log('RabbitMQ 拓扑已声明（RAG + Search + KG）');
  }

  /**
   * 把已注册的 handler 挂到队列上。
   *
   * 确认策略（手动 ack）：
   * - 处理成功 → `ack`。不 ack 的话消息会一直是 unacked，进程重启 / 连接断开后
   *   broker 会把它们重新入队，表现为「重启一次就把 RAG/Search/KG 全重跑一遍」。
   * - 处理失败 → `nack(requeue=false)`，直接丢弃，避免毒消息无限重投。
   *   代价是没有死信队列兜底，排查依赖上方的 error 日志（后续可配 DLQ）。
   *
   * prefetch：限制单个消费者同时在途的消息数，避免一次把大量消息拉进内存，
   * 也避免「长时间不 ack 导致堆积」。可用 RABBITMQ_PREFETCH 调整，默认 2。
   */
  private async bindConsumers(ch: ConfirmChannel) {
    const rawPrefetch = Number(this.config.get<string>('RABBITMQ_PREFETCH', '2'));
    const prefetch = Number.isFinite(rawPrefetch) && rawPrefetch > 0 ? rawPrefetch : 2;
    await ch.prefetch(prefetch);

    for (const [queue, handler] of this.handlers.entries()) {
      await ch.consume(
        queue,
        async (msg) => {
          if (!msg) return;

          let ok = true;
          try {
            await handler(msg);
          } catch (error) {
            ok = false;
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`消费失败 queue=${queue}: ${message}`);
          }

          // ack / nack 本身也可能因为 channel 已关闭而抛错（此时消息会被 broker 重投），
          // 单独捕获，避免把「确认失败」误判成「业务失败」。
          try {
            if (ok) {
              ch.ack(msg);
            } else {
              ch.nack(msg, false, false);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`消息确认失败 queue=${queue}: ${message}（将被 broker 重投）`);
          }
        },
        { noAck: false },
      );
      this.logger.log(`已注册消费者：${queue}`);
    }
  }
}
