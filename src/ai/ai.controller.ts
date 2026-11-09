import { AiChatService } from './ai-chat.service.js';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { HybridRetrievalService } from './hybrid-retrieval.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatDto } from './dto/chat.dto.js';
import { RagSearchDto } from './dto/rag-search.dto.js';
import { CreateSessionDto, QuerySessionDto, UpdateSessionDto } from './dto/session.dto.js';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorators.js';
import { PermissionCode } from '../common/constants/permissions.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * RAG 对外入口（两个接口，职责必须分开）
 *
 * - `POST /rag/search`：只跑「关键词 + 向量 → RRF → rerank」，**不调用 LLM**。
 *   零 token 成本、毫秒级，是调召回参数（topK / rrfC / 分词）的正确入口。
 * - `POST /ai/chat`：在上面基础上拼 context 并生成答案，返回 `{ answer, sources }`。
 *
 * 注意两点：
 * 1. 控制器**不带路径前缀**（`@Controller()`），所以真实路径就是 `/rag/search`、`/ai/chat`。
 *    写成 `@Controller('ai')` 会变成 `/ai/rag/search`，表现为 404。
 * 2. 两个接口都要求 `search` 权限码；新增检索类能力时不要漏 `@RequirePermission`。
 */
@Controller()
export class AiController {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
  ) {}

  /**
   * RAG 混合检索：关键词 BM25 + 向量 kNN → RRF → rerank。
   * 不调用 LLM，只返回 kh_chunk 命中。
   */
  @Post('rag/search')
  @RequirePermission(PermissionCode.search)
  search(@Body() dto: RagSearchDto) {
    return this.retrieval.retrieve(dto.query.trim(), dto.topK ?? 5);
  }

  /** RAG 对话：混合检索后再作答 */
  @Post('ai/chat')
  @RequirePermission(PermissionCode.search)
  chat(@Body() dto: ChatDto, @CurrentUser() user: AuthUser) {
    return this.aiChat.chat(dto.content, dto.topK ?? 5, user, dto.sessionId);
  }

  @Get('ai/sessions')
  @RequirePermission(PermissionCode.search)
  listSessions(@Query() query: QuerySessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.pageMine(user.userId, query);
  }

  @Post('ai/sessions')
  @RequirePermission(PermissionCode.search)
  createSession(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.create(user.userId, dto);
  }

  @Get('ai/sessions/:id/messages')
  @RequirePermission(PermissionCode.search)
  listMessages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.listMessages(user.userId, id);
  }

  @Patch('ai/sessions/:id')
  @RequirePermission(PermissionCode.search)
  renameSession(
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.rename(user.userId, id, dto);
  }

  @Delete('ai/sessions/:id')
  @RequirePermission(PermissionCode.search)
  removeSession(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.remove(user.userId, id);
  }
}
