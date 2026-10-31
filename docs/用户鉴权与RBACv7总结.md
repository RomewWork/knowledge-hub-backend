---
type: course-summary
status: done
course: 55
module: 用户鉴权与 RBAC
code_base: ai-agent-code/knowledge/knowledge-hub-backend
tags:
  - 课程总结
  - 鉴权
  - JWT
  - RBAC
  - NestJS
  - Agent全栈
related:
  - "[[54-文档审核与状态机]]"
  - "[[55-用户鉴权与RBAC]]"
---

# 用户鉴权与 RBAC v7 总结

> 课程 55 · 代码基线 `ai-agent-code/knowledge/knowledge-hub-backend`（v7）
> 整理时间：2026-10-31

## 一句话

**双 Token 拿身份，两个全局 Guard 把关口**：`JwtAuthGuard` 解决「你是谁」，`RolesGuard` 解决「你能不能」，审核类接口从此只对 `ROLE_REVIEWER / ROLE_ADMIN` 开放。

## 鉴权链路

```
POST /auth/login
  └─ AuthService.login
      ├─ UserService.validateCredentials  查用户 → status 校验 → bcrypt.compare → 查角色
      └─ buildLoginResult                 签发 access(2h) + refresh(7d)
  ← { accessToken, refreshToken, expiresIn, userInfo }

GET /documents   Authorization: Bearer <access>
  ├─ JwtAuthGuard（APP_GUARD #1）
  │    ├─ @Public()? → 放行
  │    └─ AuthGuard('jwt') → JwtStrategy
  │         ├─ 验签（JWT_SECRET）
  │         ├─ payload.type 必须 = 'access'
  │         └─ buildAuthUser(sub) → request.user = AuthUser
  └─ RolesGuard（APP_GUARD #2）
       ├─ 无 @Roles → 放行（仅需登录）
       └─ 有 @Roles → request.user.roles 命中其一，否则 403
```

## 数据模型

| 表 | 关键字段 | 说明 |
|---|---|---|
| `kh_user` | `id, username, password, email, real_name, avatar, status, last_login_at, deleted` | `password` 存 bcrypt hash；`status` 0 禁用 / 1 启用；软删 |
| `kh_role` | `id, role_name, role_code, description, status` | `role_code` 唯一：`ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER` |
| `kh_user_role` | `id, user_id, role_id` | 关联表，`UNIQUE(user_id, role_id)` 防重复授权 |

种子：3 个角色 + 3 个测试账号（`admin` / `reviewer` / `user`，密码均 `123456`，bcrypt 预置）。

## 新增依赖

| 包 | 用途 |
|---|---|
| `@nestjs/jwt` | 签发 / 校验 JWT |
| `@nestjs/passport` + `passport` + `passport-jwt` | Guard 与 Strategy 基础设施 |
| `bcryptjs` | 密码哈希（纯 JS，免编译） |
| `@types/passport-jwt`、`@types/bcryptjs` | 类型（dev） |

## 改动清单

| 文件 | 作用 |
|---|---|
| `src/common/constants/roles.ts` | 新增：三个角色编码常量 |
| `src/user/entities/*.entity.ts` | 新增：`UserEntity` / `RoleEntity` / `UserRoleEntity` |
| `src/user/user.service.ts` | 新增：注册、凭证校验、角色查询、构建 `AuthUser` |
| `src/auth/auth-user.interface.ts` | 新增：`request.user` 契约 |
| `src/auth/dto/auth.dto.ts` | 新增：`LoginDto / RegisterDto / RefreshTokenDto` |
| `src/auth/auth.service.ts` | 新增：双 Token 签发、登录、注册、刷新 |
| `src/auth/jwt.strategy.ts` | 新增：Bearer 解析 + 验签 + 只认 `type=access` |
| `src/auth/jwt-auth.guard.ts` | 新增：全局认证守卫（支持 `@Public`） |
| `src/auth/roles.guard.ts` | 新增：全局角色守卫（读 `@Roles` 元数据） |
| `src/auth/decorators/*` | 新增：`@Public` / `@Roles` / `@CurrentUser` |
| `src/auth/auth.module.ts` | 新增：`JwtModule` + 两个 `APP_GUARD` |
| `src/auth/auth.controller.ts` | 新增：`register / login / refresh / me / reviewer-ids` |
| `src/app.module.ts` | 改：注册 `AuthModule` 与三个用户实体 |
| `src/document/document.controller.ts` | 改：审核接口加 `@Roles`，通过 `@CurrentUser` 落审核人 |
| `init-scripts/postgresql/init.sql` | 改：三张表 + 种子数据 |

## 接口

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/auth/register` | 公开 |
| POST | `/auth/login` | 公开 |
| POST | `/auth/refresh` | 公开 |
| GET | `/auth/me` | 登录 |
| GET | `/auth/reviewer-ids` | ADMIN / REVIEWER |
| GET / POST | `/documents/reviews/tasks`、`.../pending-count`、`.../approve`、`.../reject` | REVIEWER / ADMIN |

## 关键设计

1. **双 Token**：access 短期（2h）用于每次请求，refresh 长期（7d）只用于换新。access 泄露的窗口被压缩；refresh 泄露可用撤销/轮换取救。
2. **`type` 字段隔离用途**：`JwtStrategy.validate` 只接受 `type='access'`，refresh token 无法冒充 access。
3. **角色不进 token**：`validate` 每次回查数据库（`buildAuthUser`），所以改角色立即生效；代价是每请求多两次查询，可加缓存但需处理失效。
4. **登录错误统一文案**：「用户名或密码错误」不区分用户不存在与密码错，防用户名枚举。
5. **禁用即时生效**：`buildAuthUser` 里 `status !== 1` 直接 401，不依赖 token 是否过期。
6. **`@Public` 是白名单**：全局守卫默认拦一切，登录/注册/刷新/健康检查必须显式放行。

## 易错点

| 坑 | 后果 | 正解 |
|---|---|---|
| 两个 `APP_GUARD` 顺序反了 | 全站 403（`RolesGuard` 读不到 `request.user`） | `JwtAuthGuard` 在前 |
| 漏加 `@Public()` | 登录接口自身 401 | 公开接口显式标注 |
| 健康检查没加 `@Public` | 探活一直失败 | `app.controller` 加注解 |
| 用 `bcrypt` 而非 `bcryptjs` | Windows 编译失败 | 纯 JS 版 |
| 老库直接跑 `init.sql` | 三张表不创建 | 走 migration |

## 验收

```bash
# 登录
TOKEN=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"123456"}' | jq -r .accessToken)

curl -i localhost:3000/documents                                  # 401
curl -i localhost:3000/documents -H "Authorization: Bearer $TOKEN" # 200
curl -i -X POST localhost:3000/documents/reviews/tasks/$RID/approve \
  -H "Authorization: Bearer $USER_TOKEN"                          # 403
curl -i localhost:3000/documents -H "Authorization: Bearer $REFRESH_TOKEN" # 401
```

| 检查点 | 期望 |
|---|---|
| 无 token 访问业务接口 | 401 |
| 普通用户调审核接口 | 403 |
| refresh 当 access 用 | 401 |
| 禁用用户登录 | 401「账户已禁用」 |
| 审核通过后查记录 | `reviewer_id` / `reviewer_name` 有值 |
| 改角色后不重新登录 | 立刻生效（角色每请求回查） |

## 主动回忆

1. **双 Token 解决什么？**
   access 短命降低泄露风险；refresh 长命避免频繁登录。两者用途靠 `type` 隔离，refresh 不能直连业务接口。

2. **为什么登录失败信息要统一？**
   若区分「用户不存在」和「密码错误」，攻击者可用用户名探测注册情况。统一文案把两种失败合并，阻断枚举。

3. **认证、授权、数据权限的区别？**
   认证（`JwtAuthGuard`）= 你是谁；授权（`RolesGuard`）= 你这个角色能不能调这个接口；数据权限 = 同一条接口下，你只能看到自己/本部门的数据（行级过滤，本项目尚未实现，属 56 之后）。

## 关联

- [[55-用户鉴权与RBAC]] —— 课程精读
- [[54-文档审核与状态机]] —— 上一讲
- 前一篇：`docs/文档审核与状态机v6总结.md`
