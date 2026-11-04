import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshTokenDto, RegisterDto } from './dto/auth.dto.js';
import { ResetPasswordByEmailDto, SendResetCodeDto } from '../user/dto/extra.dto.js';
import { Public } from './decorators/public.decorator.js';
import { CurrentUser } from './decorators/current-user.decorators.js';
import type { AuthUser } from './auth-user.interface.js';
import { Roles } from './decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 认证相关 HTTP 入口：注册、登录、刷新、邮箱激活、密码重置、当前用户与审核员查询。
 *
 * 依赖 AuthService（全部业务逻辑在此）、@Public 元数据、@CurrentUser 参数装饰器、@Roles 角色码。
 *
 * 坑与取舍：
 * - 除 logout / me / reviewer-ids 外都标了 @Public；新增免登录接口必须显式标注，
 *   否则会被全局 JwtAuthGuard 拦成 401。
 * - logout 是无状态的：JWT 没有黑名单，接口只返回提示，token 在过期前依然可用。
 * - refresh 从 body 取 refreshToken（该接口 @Public），不走 Authorization 头。
 * - me 返回的是守卫回查数据库后的 AuthUser，不是 token 里的内容。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /** 用 refresh token 换一对新 token；旧 refresh token 过期前仍有效（无吊销机制） */
  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Get('verify-email')
  verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @Public()
  @Post('password/reset/send-code')
  sendResetCode(@Body() dto: SendResetCodeDto) {
    return this.authService.sendResetCode(dto);
  }

  @Public()
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordByEmailDto) {
    return this.authService.resetPasswordByEmail(dto);
  }

  /** 无状态 JWT：客户端丢弃 token 即可 */
  @Post('logout')
  logout() {
    return { message: '已退出登录' };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.getMe(user.userId);
  }

  /** 返回全部有效审核员的 userId，供前端做审核人选择等场景 */
  @Get('reviewer-ids')
  @Roles(RoleCode.ADMIN, RoleCode.REVIEWER)
  getReviewerIds() {
    return this.authService.getReviewerIds();
  }
}
