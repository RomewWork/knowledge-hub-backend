import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** 创建团队：parentId 留空按 "0" 处理，即根团队 */
export class CreateTeamDto {
  @IsString()
  teamName: string;

  /** 团队编码，可选，建议唯一，便于外部系统对接与检索 */
  @IsOptional()
  @IsString()
  teamCode?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** 团队负责人（用户 ID，雪花 ID 字符串） */
  @IsOptional()
  @IsString()
  leaderId?: string;

  /** 上级团队 ID，顶层传 "0" */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  /** 0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;
}

/** 更新团队：字段全部可选，只传需要改的 */
export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  teamName?: string;

  @IsOptional()
  @IsString()
  teamCode?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  leaderId?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;
}

/** 团队分页查询：keyword 同时匹配团队名与团队编码 */
export class QueryTeamDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
