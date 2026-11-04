import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { RoleService } from './role.service.js';
import { PermissionService } from './permission.service.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/extra.dto.js';
import { AssignPermissionIdsDto } from './dto/permission.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 角色接口（/roles）
 *
 * - 类级 @Roles(ROLE_ADMIN)：整个控制器只有管理员可访问
 * - 角色 CRUD 走 RoleService；角色-权限绑定走 PermissionService（权限数据在权限侧）
 * - 列表 / 创建只回传 id、roleName、roleCode、description；详情与更新额外带 status
 *
 * 注意：/roles/list 必须注册在 /roles/:id 之前，否则 "list" 会被当作角色 ID 匹配。
 */
@Controller('roles')
@Roles(RoleCode.ADMIN)
export class RoleController {
  constructor(
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
  ) {}

  /** 全部启用角色（下拉用） */
  @Get('list')
  async listRoles() {
    const roles = await this.roleService.listAll();
    return roles.map((r) => ({
      id: r.id,
      roleName: r.roleName,
      roleCode: r.roleCode,
      description: r.description,
    }));
  }

  /** 角色详情 */
  @Get(':id')
  async getRole(@Param('id') id: string) {
    const role = await this.roleService.getById(id);
    return {
      id: role.id,
      roleName: role.roleName,
      roleCode: role.roleCode,
      description: role.description,
      status: role.status,
    };
  }

  /** 新建角色 */
  @Post()
  async createRole(@Body() dto: CreateRoleDto) {
    const role = await this.roleService.create(dto);
    return {
      id: role.id,
      roleName: role.roleName,
      roleCode: role.roleCode,
      description: role.description,
    };
  }

  /** 更新角色（名称 / 描述 / 状态） */
  @Put(':id')
  async updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    const role = await this.roleService.update(id, dto);
    return {
      id: role.id,
      roleName: role.roleName,
      roleCode: role.roleCode,
      description: role.description,
      status: role.status,
    };
  }

  /** 删除角色（仍有关联用户时 400） */
  @Delete(':id')
  async deleteRole(@Param('id') id: string) {
    await this.roleService.delete(id);
    return { message: '删除成功' };
  }

  /** 查角色已绑定的权限 ID 列表（前端回显勾选状态） */
  @Get(':id/permissions')
  @RequirePermission('system:role')
  async getRolePermissions(@Param('id') id: string) {
    const permissionIds = await this.permissionService.getRolePermissionIds(id);
    return { roleId: id, permissionIds };
  }

  /** 给角色分配权限：全量替换，传空数组即清空该角色的全部权限 */
  @Put(':id/permissions')
  @RequirePermission('system:role')
  async assignRolePermissions(@Param('id') id: string, @Body() dto: AssignPermissionIdsDto) {
    const permissionIds = await this.permissionService.assignRolePermissions(id, dto);
    return { roleId: id, permissionIds };
  }
}
