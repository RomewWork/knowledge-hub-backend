import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** 请求发送重置密码的邮箱验证码 */
export class SendResetCodeDto {
  @IsEmail()
  email: string;
}

/** 用邮箱验证码重置密码：code 为邮件里收到的验证码，新密码至少 6 位 */
export class ResetPasswordByEmailDto {
  @IsEmail()
  email: string;

  @IsString()
  code: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}

/** 创建角色：roleCode 为鉴权用的唯一编码，如 ROLE_REVIEWER */
export class CreateRoleDto {
  @IsString()
  roleName: string;

  @IsString()
  roleCode: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/** 更新角色：字段全部可选，只传需要改的；status 为 0 禁用 / 1 启用 */
export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  roleName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  status?: number;
}
