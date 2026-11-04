import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthUser } from './auth-user.interface.js';
import { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { UserService } from '../user/user.service.js';
import { EmailService } from './email.service.js';
import { EmailActivationService } from './email-activation.service.js';
import {
  PasswordResetService,
  RESET_CODE_COOLDOWN_SECONDS,
  RESET_CODE_TTL_SECONDS,
} from './password-reset.service.js';
import { ResetPasswordByEmailDto, SendResetCodeDto } from '../user/dto/extra.dto.js';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  userInfo: AuthUser;
}

interface TokenPayload {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
}

/**
 * 认证核心服务：签发/刷新 access 与 refresh 双 token，并承载注册、邮箱激活、密码重置流程。
 *
 * 依赖 UserService（校验密码、回查角色与权限）、JwtService、ConfigService（时长与环境开关）、
 * EmailService、EmailActivationService、PasswordResetService（Redis 中的一次性令牌/验证码）。
 *
 * 坑与取舍：
 * - access 默认 2h、refresh 默认 7d（可用 JWT_ACCESS_EXPIRES / JWT_REFRESH_EXPIRES 覆盖）；
 *   payload 只有 { sub, username, type }，刻意不含 roles/permissions，权限由 JwtStrategy 每请求回查数据库。
 * - refresh token 只能换新 token，不能拿去调业务接口：JwtStrategy.validate 只接受 type === 'access'。
 * - register 先落库再发激活邮件；发信失败只回滚 Redis 令牌，用户记录已存在（用户名/邮箱被占用），
 *   重新注册会 409，只能由管理员或后续重发流程补救。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
    private readonly emailActivation: EmailActivationService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  private accessExpires(): string {
    return this.config.get<string>('JWT_ACCESS_EXPIRES', '2h');
  }

  private refreshExpires(): string {
    return this.config.get<string>('JWT_REFRESH_EXPIRES', '7d');
  }

  private signAccessToken(user: AuthUser): string {
    const payload: TokenPayload = {
      sub: user.userId,
      username: user.username,
      type: 'access',
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.accessExpires() as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  private signRefreshToken(user: AuthUser): string {
    const payload: TokenPayload = {
      sub: user.userId,
      username: user.username,
      type: 'refresh',
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.refreshExpires() as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  /** 校验用户名密码，顺带更新 lastLoginAt，返回双 token 与用户信息 */
  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userService.validateCredentials(dto.username, dto.password);
    await this.userService.touchLastLogin(user.userId);
    return this.buildLoginResult(user);
  }

  async register(
    dto: RegisterDto,
  ): Promise<{ userId: string; message: string; emailVerificationRequired?: boolean }> {
    const result = await this.userService.register({
      ...dto,
      requireEmailVerification: this.requireEmailVerification(),
    });

    if (result.emailVerificationRequired && dto.email) {
      const token = await this.emailActivation.createToken(result.userId);
      try {
        await this.emailService.sendActivationEmail(dto.email, dto.username, token);
      } catch (error) {
        await this.emailActivation.deleteByToken(token);
        throw new BadRequestException('激活邮件发送失败，请稍后再试');
      }
      return {
        userId: result.userId,
        message: '注册成功，请查收邮件激活账户',
        emailVerificationRequired: true,
      };
    }

    return {
      userId: result.userId,
      message: '注册成功，请登录',
    };
  }

  /** 激活链接一次性消费；已消费或过期都回落成同一条「无效」提示 */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const userId = await this.emailActivation.consumeToken(token);
    if (!userId) {
      throw new BadRequestException('激活链接无效或已过期');
    }
    const message = await this.userService.activateEmail(userId);
    return { message };
  }

  /** 生成 6 位随机码写入 Redis 并发信；60s 内的重复请求被剩余 TTL 拦下 */
  async sendResetCode(dto: SendResetCodeDto): Promise<{ message: string }> {
    const user = await this.userService.findByEmail(dto.email);
    if (!user) {
      throw new NotFoundException('该邮箱未注册');
    }

    // Redis 剩余 TTL：刚发出去时约 600s。剩余 > 540s 说明距上次发送不足 60s，拦截重复发送
    const ttl = await this.passwordReset.getTtl(dto.email);
    if (ttl > RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS) {
      throw new BadRequestException('验证码已发送，请稍后再试');
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.passwordReset.set(dto.email, code);
    try {
      await this.emailService.sendResetCodeEmail(dto.email, user.username, code);
    } catch (error) {
      await this.passwordReset.delete(dto.email);
      throw new BadRequestException('邮件发送失败，请稍后再试');
    }
    return { message: '验证码已发送' };
  }

  /** 校验通过后改密并显式删码（verify 本身不删，失败可重试） */
  async resetPasswordByEmail(dto: ResetPasswordByEmailDto): Promise<{ message: string }> {
    if (!(await this.passwordReset.verify(dto.email, dto.code))) {
      throw new BadRequestException('验证码错误或已过期');
    }
    await this.userService.resetPasswordByEmail(dto.email, dto.newPassword);
    await this.passwordReset.delete(dto.email);
    return { message: '密码重置成功，请登录' };
  }

  /** 只认 type === 'refresh'；用户信息重新回查数据库，因此角色变更随刷新即时生效 */
  async refresh(refreshToken: string): Promise<LoginResult> {
    let payload: TokenPayload;
    try {
      payload = this.jwtService.verify<TokenPayload>(refreshToken);
    } catch (error) {
      throw new UnauthorizedException('refresh token 无效或已过期');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('无效的 refresh token');
    }
    const user = await this.userService.buildAuthUser(payload.sub);
    return this.buildLoginResult(user);
  }

  async getMe(userId: string): Promise<AuthUser> {
    return this.userService.buildAuthUser(userId);
  }

  async buildAuthUser(userId: string): Promise<AuthUser> {
    return this.userService.buildAuthUser(userId);
  }

  private accessExpiresSeconds(): number {
    const raw = this.accessExpires();
    const match = /^(\d+)([smhd])$/.exec(raw);
    if (!match) return 7200;
    const n = Number(match[1]);
    const unit = match[2];
    if (unit === 's') return n;
    if (unit === 'm') return n * 60;
    if (unit === 'h') return n * 3600;
    return n * 86400;
  }

  private requireEmailVerification(): boolean {
    return this.config.get<string>('REQUIRE_EMAIL_VERIFICATION', 'false') === 'true';
  }

  /** 审核员 ID 列表，供审核通知、任务分配等只认角色码的场景使用 */
  async getReviewerIds(): Promise<string[]> {
    return this.userService.getUserIdsByRoleCode('ROLE_REVIEWER');
  }

  private buildLoginResult(user: AuthUser): LoginResult {
    return {
      accessToken: this.signAccessToken(user),
      refreshToken: this.signRefreshToken(user),
      tokenType: 'Bearer',
      expiresIn: this.accessExpiresSeconds(),
      userInfo: user,
    };
  }
}
