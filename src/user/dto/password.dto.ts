import { IsString, MinLength } from 'class-validator';

/** 修改密码：需要提供旧密码做身份校验，新密码至少 6 位 */
export class ChangePasswordDto {
  @IsString()
  oldPassword: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}

/** 重置密码：调用前应已通过验证码/邮件链接确认身份 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(6)
  newPassword: string;
}
