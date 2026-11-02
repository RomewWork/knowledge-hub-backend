---
type: course-summary
status: done
course: 57
module: RBAC 权限系统
code_base: ai-agent-code/knowledge/knowledge-hub-backend
tags:
  - 课程总结
  - RBAC
  - 权限
  - 团队
  - Agent全栈
related:
  - "[[56-用户模块功能完善]]"
  - "[[57-RBAC权限系统]]"
---

# RBAC 权限系统 v9 总结

> 课程 57 · 代码基线 `ai-agent-code/knowledge/knowledge-hub-backend`（v9）
> 整理时间：2026-11-03

## 一句话

**从「按角色放行」升级到「按权限码放行」**：权限是一棵可配置的树（菜单/按钮/接口），角色是权限包，用户还能被直接授权；三级守卫把校验落到每个接口。

## 能力模型

```
用户最终权限 = 直授权限 ∪ 角色权限 ∪ （管理员自动追加 18 个操作权限）
```

```
kh_user ──< kh_user_role >── kh_role ──< kh_role_permission >── kh_permission
   │                                                                  │
   └────────< kh_user_permission >────────────────────────────────────┘
```

## 三层守卫链

```
请求
 ├─ JwtAuthGuard        你是谁？          → 401
 ├─ RolesGuard          @Roles 命中？     → 403
 └─ PermissionsGuard    @RequirePermission 命中？ → 403
```

`PermissionsGuard` 三分支：

| 条件 | 结果 |
|---|---|
| 未标 `@RequirePermission` | 放行 |
| 含 `ROLE_ADMIN` | **直接放行**（管理员拥有全部权限） |
| `user.permissions` 命中任一 | 放行，否则 403 |

## 数据模型（5 张新表）

| 表 | 说明 |
|---|---|
| `kh_permission` | 权限树：`parent_id`（0 为根）、`permission_type`（1 菜单 / 2 按钮 / 3 接口）、`permission_code` 唯一、`menu_url`、`api_url`+`method` |
| `kh_role_permission` | 角色 ←→ 权限 |
| `kh_user_permission` | 用户直授权限（临时提权，不建角色） |
| `kh_team` | 团队树：`parent_id`、`leader_id`、`sort` |
| `kh_team_member` | 团队成员：`(team_id, user_id)` 唯一、`member_role`（leader/member） |

## 权限码规范

`模块:操作[:资源]`，同一套 code 前端判显隐、后端判接口。

| 类型 | 示例 |
|---|---|
| 菜单（1） | `dashboard`、`document`、`search`、`profile`、`system` |
| 子菜单（1） | `system:user`、`system:role`、`system:permission`、`system:team` |
| 按钮（2） | `document:list/create/edit/delete/review`、`system:permission:create/edit/delete` |

## 接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/permissions/list`、`/tree`、`/page`、`/:id`、`/:id/children` | `system:permission` |
| POST/PUT/DELETE | `/permissions`、`/permissions/:id` | `system:permission:create/edit/delete` |
| GET/PUT | `/roles/:id/permissions` | `system:role` |
| GET/PUT | `/users/:id/permissions` | `system:user` |
| POST/PUT/DELETE | `/teams`、`/teams/:id` | `system:team` |
| GET | `/teams/page`、`/teams/tree`、`/teams/:id` | `system:team`（tree 仅 ADMIN） |
| GET/POST/DELETE | `/teams/:id/members` | `system:team` |

## 关键设计

1. **权限先归集到角色**：权限是静态资产、用户是流动的；角色做中间载体才能批量分配、复用、最小权限。
2. **直授权限作为补充**：个别临时权限不值得新建角色，`kh_user_permission` 单独授权，最终取并集并按 code 去重。
3. **全量替换式授权**：`assignRolePermissions` / `assignUserPermissions` 先 `delete` 再批量插；前端每次提交完整列表，天然幂等，不用算 diff。
4. **删除三重保护**：删权限前校验「有子权限 / 被角色绑定 / 被用户绑定」；删团队前校验「有子团队」，并**物理删除其成员关系**。
5. **授权前校验 ID 合法性**：`validatePermissionIds` 用 `In(ids)` 查一遍，数量不等直接 404，防止写入悬空关联。
6. **权限实时计算**：`getUserPermissionCodes` 每请求合并直授 + 角色（+管理员追加），改权限立即生效，不依赖重新登录。

## 一个必须知道的设计事实

`permission.controller` / `team.controller` 都用了**类级 `@Roles(ROLE_ADMIN)`**，而 `RolesGuard` 在 `PermissionsGuard` 之前执行。后果：

- 非管理员在 `RolesGuard` 就被 403 → **`@RequirePermission` 的细粒度控制对普通用户永不生效**；
- 管理员在 `PermissionsGuard` 里又直接放行。

因此这套接口实际等价于「仅 ADMIN」。`@RequirePermission` 目前的价值在于：**给前端菜单/按钮渲染用的权限码**，而不是后端真正的细粒度授权。

要让它真正生效，需去掉类级 `@Roles(ADMIN)`，把判定交给权限码。

## 易错点

| 坑 | 说明 |
|---|---|
| 三个 `APP_GUARD` 顺序 | JWT → Roles → Permissions，反了读不到 `user` |
| 老库不建表 | 5 张新表必须 migration |
| `bigint` 主键 | 雪花 ID 必须 `transformer` + 声明 `string`，否则前端 id 精度丢失 |
| 401 / 403 混用 | 未登录 401，已登录但角色/权限不足 403 |
| 漏标装饰器 | 三个装饰器都是「不写即放弃该层校验」，需逐个 controller 核对 |
| `permission_type` 填错 | 1 必须有 `menu_url`；2 的 `parent_id` 指向菜单；3 才有 `api_url`+`method` |
| 团队删除 | 会**物理删除成员关系**（`memberRepo.delete`），不是软删 |
| 性能 | `getUserPermissionCodes` 每请求 4 次查询，应加缓存并在授权后失效 |

## 验收

```bash
# 权限树
curl localhost:3000/permissions/tree -H "Authorization: Bearer $ADMIN"

# 建权限点
curl -X POST localhost:3000/permissions -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"permissionName":"导出文档","permissionCode":"document:export","permissionType":2}'

# 角色配权限（全量替换）
curl -X PUT localhost:3000/roles/$RID/permissions -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"permissionIds":["4000000000000000011"]}'

# 用户直授
curl -X PUT localhost:3000/users/$UID/permissions -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"permissionIds":["4000000000000000012"]}'

# 团队 + 成员
curl -X POST localhost:3000/teams -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"teamName":"研发中心"}'
curl -X POST localhost:3000/teams/$TID/members -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"userIds":["1001"]}'

# 普通用户访问权限管理 → 403
curl -i localhost:3000/permissions/list -H "Authorization: Bearer $USER"
```

| 检查点 | 期望 |
|---|---|
| `/auth/me` | 返回 `roles` + `permissions` |
| 管理员 | 自动含 18 个 `ADMIN_OPERATION_PERMISSIONS` |
| 普通用户 | 只有角色/直授带来的权限码 |
| 重复 PUT 权限列表 | 结果稳定（全量替换） |
| 删除有子节点的权限 | 400 |
| 删除仍被角色使用的权限 | 400 |
| 删除有子团队的团队 | 400 |
| 删除团队 | 成员关系一并消失 |

## 主动回忆

1. **为什么要引入角色这一层，不直接给用户挂权限？**
   权限是静态资产、用户是流动的；直连会导致人员变动时逐条增删、无法复用、容易漏配。角色作为权限包实现批量分配与最小权限。

2. **Guard 顺序为什么不能换？**
   先认证才拿到 `user` 上下文；反了会把未登录误报成 403，或让请求在无身份时进入权限判断。

3. **`permission_type` 三种类型字段要求？**
   1 菜单必须 `menu_url`；2 按钮的 `parent_id` 指向所属菜单；3 接口才有 `api_url` + `method`（预留给自动化映射）。

4. **菜单过滤 / 按钮过滤 / 接口校验，哪个是安全边界？**
   只有**接口校验**是安全边界；前两者是体验层，前端可以绕过。

5. **RBAC 表达不了什么？**
   行级数据权限（「只能看本团队文档」）。需要文档可见性字段 + 查询过滤补，即 RBAC 管功能、ABAC/数据范围管行。

## 关联

- [[57-RBAC权限系统]] —— 课程精读
- [[56-用户模块功能完善]] —— 上一讲
- 前一篇：`docs/用户模块功能完善v8总结.md`
