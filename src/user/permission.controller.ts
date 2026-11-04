import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { PermissionService } from './permission.service.js';
import {
  AssignPermissionIdsDto,
  CreatePermissionDto,
  QueryPermissionDto,
  UpdatePermissionDto,
} from './dto/permission.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 权限接口（/permissions）：菜单 / 按钮 / 接口三类权限的维护
 *
 * - 类级 @Roles(ROLE_ADMIN)，整个控制器只对管理员开放
 * - 各方法上的 @RequirePermission('system:permission...') 目前是「形式大于实质」：
 *   RolesGuard 先拦掉了非管理员，而 PermissionsGuard 又对 ROLE_ADMIN 一律放行，
 *   所以权限码对普通用户实际不生效；它当前的真正用途是前端菜单渲染，
 *   即作为权限树 / 权限列表的数据来源；将来若放开给非管理员调用，这套权限码才会真正生效
 * - 路由顺序：list / tree / page 必须注册在 :id 之前，否则会被当成权限 ID 匹配
 */
@Controller('permissions')
@Roles(RoleCode.ADMIN)
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  /** 全部启用权限（扁平列表） */
  @Get('list')
  @RequirePermission('system:permission')
  async list() {
    return this.permissionService.listAll();
  }

  /** 权限树（parentId='0' 为根，children 递归嵌套） */
  @Get('tree')
  @RequirePermission('system:permission')
  async tree() {
    return this.permissionService.getTree();
  }

  /** 权限分页（关键词匹配名称 / 编码） */
  @Get('page')
  @RequirePermission('system:permission')
  async page(@Query() query: QueryPermissionDto) {
    return this.permissionService.page(query);
  }

  /** 直接子权限（阶梯加载用） */
  @Get(':id/children')
  @RequirePermission('system:permission')
  async children(@Param('id') id: string) {
    return this.permissionService.getChildren(id);
  }

  /** 权限详情（:id 路由在静态路由之后注册） */
  @Get(':id')
  @RequirePermission('system:permission')
  async getById(@Param('id') id: string) {
    return this.permissionService.getById(id);
  }

  /** 新建权限（菜单 / 按钮 / 接口共用，permissionCode 唯一） */
  @Post()
  @RequirePermission('system:permission:create')
  async create(@Body() dto: CreatePermissionDto) {
    return this.permissionService.create(dto);
  }

  /** 更新权限（字段按需传，undefined 的字段不覆盖） */
  @Put(':id')
  @RequirePermission('system:permission:edit')
  async update(@Param('id') id: string, @Body() dto: UpdatePermissionDto) {
    return this.permissionService.update(id, dto);
  }

  /** 删除权限（软删；有子权限或仍被角色/用户绑定时 400） */
  @Delete(':id')
  @RequirePermission('system:permission:delete')
  async delete(@Param('id') id: string) {
    await this.permissionService.delete(id);
    return { message: '删除成功' };
  }
}
