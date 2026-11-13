import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { DocumentService } from './document.service.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';
import { QueryDocumentDto } from './dto/query-document.dto.js';
import { UploadParseDto } from './dto/upload-parse.dto.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { QueryReviewTasksDto, ReviewDecisionDto } from './dto/review.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorators.js';
import { DocumentReviewService } from './document-review.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import { PermissionCode } from '../common/constants/permissions.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * 文档接口（需 JWT；审核相关接口需 ROLE_REVIEWER 或 ROLE_ADMIN）
 *
 * 依赖：DocumentService（文档 CRUD / 状态流转）、DocumentReviewService（提审 / 审核 / 待办）。
 * 登录用户统一由 @CurrentUser() 注入，作者与操作人只在服务端写入，请求体无法指定。
 *
 * 坑：
 * - 路由按声明顺序匹配，静态路径（reviews/tasks、reviews/tasks/pending-count）必须写在
 *   @Get(':id') 之前，否则会被 :id 当作文档 ID 吃掉，表现为 404 或查错文档。
 * - 状态变更不要新增 PATCH 通道：publish / archive / save-draft / 审核接口才是状态机入口。
 * - 多权限码的 @RequirePermission 是「任一满足即可」，且 ROLE_ADMIN 自动放行。
 */
@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly reviewService: DocumentReviewService,
  ) {}

  /** 创建文档 */
  @Post()
  @RequirePermission(PermissionCode.documentCreate)
  create(@Body() dto: CreateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.create(dto, user);
  }

  /** 上传文件并解析为 Markdown，创建草稿（form-data 字段名: file） */
  @Post('upload/parse')
  @RequirePermission(PermissionCode.documentCreate)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadAndParse(
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadParseDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) {
      throw new BadRequestException('请上传文件（form-data 字段名: file）');
    }
    return this.documentService.uploadAndCreateDocument(file, meta, user);
  }

  /** 审核待办列表（须在 @Get(':id') 之前注册，避免路由被 :id 吃掉） */
  @Get('reviews/tasks')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  listReviewTasks(@Query() query: QueryReviewTasksDto) {
    return this.reviewService.listTasks(query);
  }

  /** 待审核数量（导航角标等） */
  @Get('reviews/tasks/pending-count')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  pendingReviewCount() {
    return this.reviewService.getPendingCount();
  }

  /** 分页查询文档列表（仅元数据） */
  @Get()
  @RequirePermission(PermissionCode.documentList)
  findAll(@Query() query: QueryDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.findAll(query, user);
  }

  /** 发布文档（需审核时进入待审；免审则直接发布并投递 MQ） */
  @Put(':id/publish')
  @RequirePermission(PermissionCode.documentEdit)
  publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.publish(id, user);
  }

  /** 归档：Published → Archived，并清 RAG/Search/KG 索引 */
  @Put(':id/archive')
  @RequirePermission(PermissionCode.documentEdit)
  archive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.archive(id, user);
  }

  /** 下架编辑：Published → Draft，清索引后可改内容再提审/发布 */
  @Put(':id/save-draft')
  @RequirePermission(PermissionCode.documentEdit)
  saveAsDraft(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.saveAsDraft(id, user);
  }

  /** 单独提交审核（也可由 publish 在需审核时内部调用） */
  @Post(':id/reviews/submit')
  @RequirePermission(PermissionCode.documentEdit)
  submitReview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reviewService.submitForReview(id, user);
  }

  /** 当前待审记录（review_result IS NULL） */
  @Get(':id/reviews/current')
  @RequirePermission(PermissionCode.documentList, PermissionCode.documentReview)
  getCurrentReview(@Param('id') id: string) {
    return this.reviewService.getCurrentReview(id);
  }

  /** 该文档全部审核历史，按 created_at 倒序 */
  @Get(':id/reviews/history')
  @RequirePermission(PermissionCode.documentList, PermissionCode.documentReview)
  getReviewHistory(@Param('id') id: string) {
    return this.reviewService.getReviewHistory(id);
  }

  /** 审核通过 → 文档 Published + 重建索引 */
  @Post('reviews/tasks/:taskId/approve')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  approveReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviewService.approveReview(
      taskId,
      user.userId,
      user.realName ?? user.username,
      dto.reviewComment,
    );
  }

  /** 审核驳回 → 文档回 Draft，作者可修改后再次 submit */
  @Post('reviews/tasks/:taskId/reject')
  @Roles(RoleCode.REVIEWER, RoleCode.ADMIN)
  @RequirePermission(PermissionCode.documentReview)
  rejectReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviewService.rejectReview(
      taskId,
      dto.reviewComment ?? '',
      user.userId,
      user.realName ?? user.username,
    );
  }

  /**
   * 查询文档详情（含正文）
   * :id 通配必须最后声明；后续新增静态 GET 路由请一律加在这个方法之前
   */
  @Get(':id')
  @RequirePermission(PermissionCode.documentList)
  findOne(@Param('id') id: string) {
    return this.documentService.findOne(id);
  }

  /** 更新文档 */
  @Patch(':id')
  @RequirePermission(PermissionCode.documentEdit)
  update(@Param('id') id: string, @Body() dto: UpdateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.update(id, dto, user);
  }

  /** 软删除文档 */
  @Delete(':id')
  @RequirePermission(PermissionCode.documentDelete)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentService.remove(id, user);
  }
}
