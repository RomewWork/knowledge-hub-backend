import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from './auth.service.js';

interface JwtPayload {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
}

/**
 * Passport JWT 策略：从 Authorization: Bearer 取 token 验签，再回查数据库产出 AuthUser。
 *
 * 依赖 ConfigService（JWT_SECRET，须与 JwtModule 签发时一致）、AuthService.buildAuthUser。
 *
 * 坑与取舍：
 * - validate 只接受 payload.type === 'access'，拿 refresh token 调业务接口一律 401 ——
 *   这是 access/refresh 分离的落点，refresh 只能走 /auth/refresh。
 * - 每个请求都会 buildAuthUser 回查数据库读角色与权限，所以改角色/权限立即生效，
 *   代价是每请求多几次查询；payload 里刻意不放 roles/permissions。
 * - 文件名 startegy 是历史拼写错误，import 依赖它，别改名。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
    });
  }

  /** 返回值会挂到 request.user；账户被禁用时 buildAuthUser 会抛 401 */
  async validate(payload: JwtPayload) {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('无效的 access token');
    }
    return this.authService.buildAuthUser(payload.sub);
  }
}
