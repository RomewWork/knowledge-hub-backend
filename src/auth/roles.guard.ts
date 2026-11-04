import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth-user.interface.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { RoleCodeValue } from '../common/constants/roles.js';

/**
 * 角色守卫：按 @Roles 声明的角色码校验 request.user.roles（任一命中即通过）。
 *
 * 依赖 Reflector 读元数据、RoleCode 常量、AuthUser（角色来自数据库实时回查，不来自 token）。
 *
 * 坑与取舍：
 * - 未标 @Roles 的接口一律放行（只要求已登录），权限收敛必须显式标注，漏标不会报错。
 * - 与 PermissionsGuard 是「同时满足」关系：两个装饰器都标时，角色与权限码都得过。
 * - 方法级元数据覆盖类级（getAllAndOverride）。
 */

/**
 * 角色守卫（RBAC 简化版）
 *
 * <p>在 {@link JwtAuthGuard} 之后执行（同为 APP_GUARD，按注册顺序：先 JWT、后 Roles）。</p>
 *
 * <p>规则：</p>
 * <ul>
 *   <li>接口未标 {@link Roles} → 放行（仅要求已登录）</li>
 *   <li>接口标了 {@code @Roles('ROLE_REVIEWER', ...)} → request.user.roles 须命中其一</li>
 *   <li>不满足 → 403 权限不足</li>
 * </ul>
 *
 * <p>示例：文档审核 approve/reject 需 {@code ROLE_REVIEWER} 或 {@code ROLE_ADMIN}。</p>
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RoleCodeValue[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user?.roles?.length) {
      throw new ForbiddenException('权限不足');
    }

    const ok = requiredRoles.some((role) => user.roles.includes(role));
    if (!ok) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}
