import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * 图谱查询入参
 *
 * query string 里拿到的都是字符串，数值字段必须 @Type(() => Number) 转换，
 * 否则 @IsInt() 直接校验失败。
 */
export class GraphQueryDto {
  /** 节点类型过滤（仅 listNodes 使用），如 CONCEPT / PERSON */
  @IsOptional()
  @IsString()
  type?: string;

  /** 返回条数上限，防止一次拉全库；默认值在 controller 里给 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** 关键词检索入参（GraphSearchDto） */
export class GraphSearchDto {
  /** 检索词，至少 1 个字符；service 内会 toLower + CONTAINS 匹配 */
  @IsString()
  @MinLength(1)
  keyword: string;

  /** 返回条数上限，比列表接口更严格（检索是全图扫描，代价更高） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
