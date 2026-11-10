/**
 * 流式问答请求体的校验规则。
 *
 * 职责：只做形状校验与类型转换，真正的「最后一条用户问题」提取在 AiStreamService.lastUserText 里。
 * 关键依赖：class-validator / class-transformer，配合全局 ValidationPipe（whitelist + forbidNonWhitelisted）。
 *
 * 坑：
 * - messages 是 useChat 的 { role, parts: [{ type, text }] } 结构，不是 content 字符串；
 *   这里只校验 IsArray，元素内部结构由业务层容错。
 * - id / trigger / messageId 是 SDK 自动附带的额外字段，trigger、messageId 必须 @Allow() 放行，
 *   否则 forbidNonWhitelisted 会直接 400，请求根本进不了 service。
 * - topK 限制 1~10；sessionId 可选，不传则由后端新建会话。
 */

import { Type } from 'class-transformer';
import { Allow, IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** useChat Data Stream 请求体（额外字段放行） */
export class ChatStreamDto {
  @IsArray()
  messages: Array<{
    role?: string;
    parts?: Array<{ type?: string; text?: string }>;
  }>;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number;

  /**
   * id 用 @IsString 参与白名单；trigger / messageId 是任意结构，只能 @Allow() 放行，
   * 它们都由 SDK 自动生成，业务侧不读取。
   */
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @Allow()
  trigger?: unknown;

  @IsOptional()
  @Allow()
  messageId?: unknown;
}
