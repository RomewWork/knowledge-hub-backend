import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { UserService } from './user.service.js';
import { PermissionService } from './permission.service.js';
import { QueryUserDto } from './dto/query-user.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { AssignRolesDto } from './dto/assign-roles.dto.js';
import { UpdateProfileDto } from './dto/profile.dto.js';
import { ChangePasswordDto, ResetPasswordDto } from './dto/password.dto.js';
import { AssignPermissionIdsDto } from './dto/permission.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorators.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * 用户接口（/users）
 *
 * - 自助接口：/users/me、/users/me/stats、/users/password/change，只操作当前登录用户
 * - 管理接口：统一 @Roles(ROLE_ADMIN)，覆盖分页、增删改、角色与直授权限
 *
 * 注意：路由注册顺序有强约束 —— me、me/stats、password/change 必须写在 :id 之前，
 * 否则会被 @Put(':id') / @Get(':id') 抢先匹配（"me" 被当成 userId，直接 404 用户不存在）。
 * 另外 /:id/permissions 上的 @RequirePermission('system:user') 实际是冗余的：
 * 类内这些接口本身已限定 ADMIN，而权限守卫对 ROLE_ADMIN 一律放行。
 */
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly permissionService: PermissionService,
  ) {}

  /** 当前用户修改自己的资料（userId 取自登录态，不接受请求体传 id） */
  @Put('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.userService.updateProfile(user.userId, dto);
  }

  /** 当前用户的作品统计（文档数、浏览、点赞、评论） */
  @Get('me/stats')
  getMyStats(@CurrentUser() user: AuthUser) {
    return this.userService.getUserStatistics(user.userId);
  }

  /** 当前用户改密码：需提供原密码，服务端 bcrypt 校验通过才落新哈希 */
  @Put('password/change')
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.userService.changePassword(user.userId, dto.oldPassword, dto.newPassword);
    return { message: '密码修改成功' };
  }

  /** 用户分页（关键词 / 状态 / 角色筛选） */
  @Get('page')
  @Roles(RoleCode.ADMIN)
  pageUsers(@Query() query: QueryUserDto) {
    return this.userService.pageUsers(query);
  }

  /** 用户详情（含角色码）；注意它在 me 系列之后注册 */
  @Get(':id')
  @Roles(RoleCode.ADMIN)
  getUser(@Param('id') id: string) {
    return this.userService.getUserVO(id);
  }

  /** 管理员创建用户：直接置 emailVerified=1，并把 roleCodes 全量写入（缺省 ROLE_USER） */
  @Post()
  @Roles(RoleCode.ADMIN)
  async createUser(@Body() dto: CreateUserDto) {
    const userId = await this.userService.createUser(dto);
    return this.userService.getUserVO(userId);
  }

  /** 管理员更新用户资料（含状态；不能改密码和角色） */
  @Put(':id')
  @Roles(RoleCode.ADMIN)
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.userService.updateUser(id, dto);
  }

  /** 管理员删除用户（软删，deleted=true，历史数据保留） */
  @Delete(':id')
  @Roles(RoleCode.ADMIN)
  async deleteUser(@Param('id') id: string) {
    await this.userService.deleteUser(id);
    return { message: '删除成功' };
  }

  /** 管理员重置密码（无需原密码） */
  @Put(':id/password/reset')
  @Roles(RoleCode.ADMIN)
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    await this.userService.resetPassword(id, dto.newPassword);
    return { message: '密码重置成功' };
  }

  /** 查用户角色码（用户不存在会 404） */
  @Get(':id/roles')
  @Roles(RoleCode.ADMIN)
  async getUserRoles(@Param('id') id: string) {
    const roleCodes = await this.userService.getUserRoleCodes(id);
    return { userId: id, roleCodes };
  }

  /** 设置用户角色：全量替换（传空数组等于清空），不是追加 */
  @Put(':id/roles')
  @Roles(RoleCode.ADMIN)
  async assignRoles(@Param('id') id: string, @Body() dto: AssignRolesDto) {
    const roleCodes = await this.userService.replaceRoles(id, dto.roleCodes);
    return { userId: id, roleCodes };
  }

  /**
   * 查用户权限：permissionCodes 是「直授 ∪ 角色 ∪ 管理员追加」后的合并结果，
   * directPermissionIds 只含直接授权，供前端回显勾选状态
   */
  @Get(':id/permissions')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:user')
  async getUserPermissions(@Param('id') id: string) {
    await this.userService.findByIdOrThrow(id);
    const permissionCodes = await this.permissionService.getUserPermissionCodes(id);
    const permissionIds = await this.permissionService.getUserDirectPermissionIds(id);
    return { userId: id, permissionCodes, directPermissionIds: permissionIds };
  }

  /** 设置用户直授权限：全量替换，与角色权限叠加生效（不会覆盖角色权限） */
  @Put(':id/permissions')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:user')
  async assignUserPermissions(@Param('id') id: string, @Body() dto: AssignPermissionIdsDto) {
    await this.userService.findByIdOrThrow(id);
    const permissionIds = await this.permissionService.assignUserPermissions(id, dto);
    return { userId: id, permissionIds };
  }
}
