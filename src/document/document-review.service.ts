import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager, IsNull } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { DocumentPipelinePublisher } from '../mq/document-pipeline.publisher.js';
import { canSubmitReview, DocumentStatus } from './document-status.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentReviewEntity, ReviewResult } from './entities/document.review.entity.js';
import { DocumentContent, DocumentContentDocument } from './schemas/document-content.schema.js';
import { QueryReviewTasksDto } from './dto/review.dto.js';
import { AuthUser } from '../auth/auth-user.interface.js';
import { canWriteDocument } from './document-access.js';

/**
 * 文档发布审核服务
 *
 * 与 kh_document_review 表对应：每次 submit 插入一条记录，approve/reject 回填结果。
 * 开关：环境变量 DOCUMENT_REQUIRE_APPROVAL（默认 true；false 时 publish 跳过本服务直接发布）。
 *
 * 关键依赖：EntityManager（kh_document / kh_document_review）、contentModel、pipelinePublisher、
 * ConfigService（读审核开关）。
 *
 * 坑与取舍：
 * - 同一文档同时只允许一条待审记录，靠 review_result IS NULL 查询在应用层校验，并发下仍可能重复插入。
 * - 来自 Published 的提审会先清索引，审核期间文档不可被检索；驳回后回 Draft 也不会自动重建索引。
 * - 驳回必须填 reviewComment（否则 400），通过不强制填。
 * - 索引投递失败只告警，不回滚审核结果。
 */
@Injectable()
export class DocumentReviewService {
  private readonly logger = new Logger(DocumentReviewService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly pipelinePublisher: DocumentPipelinePublisher,
    private readonly config: ConfigService,
  ) {}

  /** 是否开启发布审核（默认 true，DOCUMENT_REQUIRE_APPROVAL=false 时免审） */
  isRequireApproval(): boolean {
    return this.config.get<string>('DOCUMENT_REQUIRE_APPROVAL', 'true') !== 'false';
  }

  /**
   * 提交审核：Draft / Published → PendingReview
   * 若来自 Published，先清索引（审核期间不可检索）
   */
  async submitForReview(documentId: string, actor?: AuthUser): Promise<DocumentEntity> {
    const doc = await this.findDocumentOrThrow(documentId);
    if (actor && !canWriteDocument(doc, actor)) {
      throw new ForbiddenException('无权提交该文档审核');
    }

    if (!canSubmitReview(doc.status)) {
      throw new BadRequestException('只有草稿或已发布状态的文档才能提交审核');
    }

    const pending = await this.em.findOne(DocumentReviewEntity, {
      where: { documentId, reviewResult: IsNull() },
    });
    // 同一文档同时只能有一条待审记录
    if (pending) {
      throw new BadRequestException('该文档已有待审核任务');
    }

    const beforeStatus = doc.status;
    // 写入审核流水；review_result 留空表示待审
    const review = this.em.create(DocumentReviewEntity, {
      id: nextSnowflakeId(),
      documentId,
      beforeStatus,
    });
    await this.em.save(review);

    doc.status = DocumentStatus.PendingReview;
    if (actor?.userId) doc.updateBy = actor.userId;
    const saved = await this.em.save(doc);

    if (beforeStatus === DocumentStatus.Published) {
      await this.safeUnpublish(documentId);
    }

    this.logger.log(
      `文档已提交审核：documentId=${documentId}, reviewId=${review.id}, beforeStatus=${beforeStatus}`,
    );

    return saved;
  }

  /**
   * 审核通过：回填 review_result，文档置 Published 并写 publishTime，再投递索引重建
   * 已处理过的任务会被 findPendingReviewOrThrow 拦下，重复调用只会抛 400
   */
  async approveReview(
    reviewId: string,
    reviewerId?: string,
    reviewerName?: string,
    reviewComment?: string,
  ): Promise<DocumentEntity> {
    const review = await this.findPendingReviewOrThrow(reviewId);

    review.reviewResult = ReviewResult.Approved;
    review.reviewerId = reviewerId;
    review.reviewerName = reviewerName;
    review.reviewComment = reviewComment ?? null;
    review.reviewedAt = new Date();
    await this.em.save(review);

    const doc = await this.findDocumentOrThrow(review.documentId);
    doc.status = DocumentStatus.Published;
    doc.publishTime = new Date();
    const saved = await this.em.save(doc);
    await this.safePublish(saved);

    this.logger.log(`审核通过：reviewId=${reviewId}, documentId=${doc.id}`);
    return saved;
  }

  /**
   * 审核驳回：reviewComment 必填（否则 400），文档回 Draft，作者修改后可再次提审
   * 驳回不投递索引清理：待审期（来自 Published）提审时已经清过
   */
  async rejectReview(
    reviewId: string,
    reviewComment: string,
    reviewerId?: string,
    reviewerName?: string,
  ): Promise<DocumentEntity> {
    if (!reviewComment?.trim()) {
      throw new BadRequestException('驳回意见不能为空');
    }

    const review = await this.findPendingReviewOrThrow(reviewId);

    review.reviewResult = ReviewResult.Rejected;
    review.reviewerId = reviewerId;
    review.reviewerName = reviewerName;
    review.reviewComment = reviewComment.trim() ?? null;
    review.reviewedAt = new Date();
    await this.em.save(review);

    const doc = await this.findDocumentOrThrow(review.documentId);
    doc.status = DocumentStatus.Draft;
    const saved = await this.em.save(doc);

    this.logger.log(`审核驳回：reviewId=${reviewId}, documentId=${doc.id}`);
    return saved;
  }

  /** 审核任务分页：默认只查待办（review_result IS NULL），可按 approved / rejected 过滤 */
  async listTasks(query: QueryReviewTasksDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.em.createQueryBuilder(DocumentReviewEntity, 'r');

    if (query.status === 'pending' || !query.status) {
      qb.andWhere('r.review_result IS NULL');
    } else if (query.status === 'approved') {
      qb.andWhere('r.review_result = :result', {
        result: ReviewResult.Approved,
      });
    } else if (query.status === 'rejected') {
      qb.andWhere('r.review_result = :result', {
        result: ReviewResult.Rejected,
      });
    }

    qb.orderBy('r.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /** 待审核任务数：review_result IS NULL 的总条数，供导航角标轮询 */
  getPendingCount(): Promise<number> {
    return this.em.count(DocumentReviewEntity, {
      where: { reviewResult: IsNull() },
    });
  }

  /** 取待审记录；不存在抛 404，已处理（review_result 非空）抛 400，防重复审核 */
  private async findPendingReviewOrThrow(reviewId: string) {
    const review = await this.em.findOne(DocumentReviewEntity, {
      where: { id: reviewId },
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found`);
    }
    if (review.reviewResult != null) {
      throw new BadRequestException('该审核任务已处理');
    }
    return review;
  }

  /** 取未软删文档，不存在抛 404（审核时文档可能已被删除） */
  private async findDocumentOrThrow(id: string) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    return doc;
  }

  /** 审核通过后投递索引重建；MQ 失败只告警，不影响审核结果 */
  private async safePublish(doc: DocumentEntity) {
    try {
      await this.pipelinePublisher.afterPublish(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`审核通过后索引投递失败：documentId=${doc.id}, ${message}`);
    }
  }

  /** 提审时清理该文档的索引；MQ 失败只告警，状态仍进 PendingReview */
  private async safeUnpublish(documentId: string) {
    try {
      await this.pipelinePublisher.afterUnpublish(documentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`提交审核后索引清理失败：documentId=${documentId}, ${message}`);
    }
  }

  /** 该文档当前待审任务（无则 null） */
  async getCurrentReview(documentId: string) {
    return this.em.findOne(DocumentReviewEntity, {
      where: { documentId, reviewResult: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** 该文档全部审核记录（含已通过、已驳回） */
  async getReviewHistory(documentId: string) {
    return this.em.find(DocumentReviewEntity, {
      where: { documentId },
      order: { createdAt: 'DESC' },
    });
  }
}
