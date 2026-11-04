import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 全文检索入参
 *
 * 全部走 `@Type(() => Number)` 转换：query/body 里拿到的都是字符串，
 * 不显式转换的话 `@IsInt()` 会校验失败。
 */
export class SearchDocumentsDto {
  /** 检索词，必填；交给 ES 的 ik_smart 分词后匹配 title/summary/content */
  @IsString()
  @IsNotEmpty()
  keyword: string;

  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** 每页条数，上限 50（与 service 里的 Math.min 双保险，防止一次拉全库） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 10;

  /** 按分类精确筛选（走 ES filter，不参与打分） */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** 按作者精确筛选（走 ES filter，不参与打分） */
  @IsOptional()
  @IsString()
  authorId?: string;
}
