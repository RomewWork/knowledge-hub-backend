import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth-user.interface.js';
import { PERMISSIONS_KEY } from './decorators/require-permission.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 权限码守卫：按 @RequirePermission 声明的权限码校验 request.user.permissions（任一命中即通过）。
 *
 * 依赖 Reflector 读元数据、AuthUser（由 JwtStrategy 每请求回查数据库后写入 request.user）。
 *
 * 坑与取舍：
 * - ROLE_ADMIN 直接放行，不校验具体权限码，新增权限点时不必再给管理员授权。
 * - 全局 APP_GUARD 顺序为 JwtAuthGuard → RolesGuard → PermissionsGuard，user 由 JwtAuthGuard（内含
 *   JwtStrategy）写入 request；顺序被调乱时，标了 @RequirePermission 的接口会全部 403。
 * - 方法级元数据覆盖类级（getAllAndOverride）；未标 @RequirePermission 的接口直接放行，不是默认拒绝。
 */

/**
 * 权限码守卫（在 JwtAuthGuard、RolesGuard 之后执行）
 *
 * - 未标 @RequirePermission → 放行
 * - ROLE_ADMIN → 放行
 * - 否则 request.user.permissions 须命中其一
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('权限不足');
    }

    if (user.roles.includes(RoleCode.ADMIN)) {
      return true;
    }

    const owned = new Set(user.permissions ?? []);
    const ok = required.some((p) => owned.has(p));
    if (!ok) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}
