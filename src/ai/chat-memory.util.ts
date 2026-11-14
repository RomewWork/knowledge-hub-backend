/**
 * 对话记忆的纯函数工具，被短期记忆、检索改写与历史回放链路共用。
 *
 * 职责：统一 LangChain 消息与 Postgres 行之间的转换、消息类型过滤、改写上下文压缩。
 *
 * 坑：
 * - content 既可能是 string，也可能是多段内容块数组，直接当字符串用会丢掉正文。
 * - 回放只能留 human/ai：system/tool 会和本轮 prompt 打架，还会把工具原始输出再喂回去。
 * - compactRewriteContext 里助手侧截得比用户侧更短，防止制度原文被当成检索词。
 */

import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AiMessageEntity } from './entities/ai-message.entity.js';

/**
 * 取消息正文：兼容 string 与内容块数组两种 content，非字符串内容兜底成空串，
 * 避免拼 prompt 时出现 [object Object] 或直接抛异常。
 */
export function messageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return String(content ?? '').trim();
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: string }).text ?? '');
      }
      return '';
    })
    .join('')
    .trim();
}

/**
 * 只保留 human/ai 两类消息，用于缓存与回放：
 * system 消息会携带记忆注入和系统约束，tool 消息是工具原始输出，
 * 回放它们既会和本轮 prompt 冲突，也会让模型把旧工具结果当成事实。
 */
export function isWorkingMessage(message: BaseMessage): boolean {
  return HumanMessage.isInstance(message) || AIMessage.isInstance(message);
}

/**
 * 把 Postgres 里的消息行还原成 LangChain 历史：空内容直接丢弃（多为流式中断残留），
 * 非 user/assistant 的角色一律忽略，保证回放历史里只有干净的一问一答。
 */
export function dbRowsToMessages(rows: AiMessageEntity[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const row of rows) {
    const text = row.content?.trim();
    if (!text) continue;
    if (row.role === 'user') out.push(new HumanMessage(text));
    if (row.role === 'assistant') out.push(new AIMessage(text));
  }
  return out;
}

/** 给检索改写器用：最近几轮，助手只留短摘要，避免制度原文污染 query */
export function compactRewriteContext(history: BaseMessage[]): string {
  if (!history.length) return '';
  const lines: string[] = [];
  for (const message of history.slice(-4)) {
    const text = messageText(message);
    if (!text) continue;
    if (HumanMessage.isInstance(message)) {
      lines.push(`用户：${text.slice(0, 200)}`);
    } else if (AIMessage.isInstance(message)) {
      lines.push(`助手：${text.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}
