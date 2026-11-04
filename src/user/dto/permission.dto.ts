import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 创建权限：菜单（1）/ 按钮（2）/ 接口（3）三种类型共用一套 DTO */
export class CreatePermissionDto {
  @IsString()
  permissionName: string;

  @IsString()
  permissionCode: string;

  /** 权限类型：1 菜单 2 按钮 3 接口 */
  @Type(() => Number)
  @IsInt()
  permissionType: number;

  /** 父权限 ID，顶层传 "0"（与数据库 default '0' 对应） */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  menuUrl?: string;

  @IsOptional()
  @IsString()
  apiUrl?: string;

  /** HTTP 方法，配合 apiUrl 做接口级鉴权 */
  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  icon?: string;

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

/** 更新权限：字段全部可选，只传需要改的 */
export class UpdatePermissionDto {
  @IsOptional()
  @IsString()
  permissionName?: string;

  @IsOptional()
  @IsString()
  permissionCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  permissionType?: number;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  menuUrl?: string;

  @IsOptional()
  @IsString()
  apiUrl?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;
}

/** 权限分页查询：keyword 模糊匹配名称/编码，pageSize 上限 100 */
export class QueryPermissionDto {
  @IsOptional()
  @IsString()
  keyword?: string;

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

/** 给用户/角色直接分配权限：传权限 ID 数组（雪花 ID 字符串） */
export class AssignPermissionIdsDto {
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}
