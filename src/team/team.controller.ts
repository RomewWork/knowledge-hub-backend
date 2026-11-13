import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { TeamService } from './team.service.js';
import { CreateTeamDto, QueryTeamDto, UpdateTeamDto } from './dto/team.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorators.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 团队管理 HTTP 接口
 *
 * 职责：把 /teams 下的增删改查、树查询、成员维护暴露成 REST 接口，参数校验交给 DTO。
 *
 * 关键依赖：TeamService；鉴权依赖 @Roles / @RequirePermission 装饰器与全局守卫。
 *
 * 坑与取舍：
 * 1. 整个控制器限 ADMIN 角色，但 getTree 额外标了 @Public，是给前端选人/选团队组件用的公开接口。
 * 2. 路由顺序不能乱：'page'、'tree' 必须写在 ':id' 之前，否则会被当成 id 匹配走。
 * 3. 成员接口的入参是裸数组（@Body() userIds: string[]），没有包 DTO，少写一层校验，调用方需自行保证格式。
 */
@Controller('teams')
@Roles(RoleCode.ADMIN)
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  /** 新建团队 */
  @Post()
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  create(@Body() dto: CreateTeamDto) {
    return this.teamService.create(dto);
  }

  /** 更新团队（字段级增量更新） */
  @Put(':id')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.teamService.update(id, dto);
  }
  /** 删除团队；有子团队时由 service 抛 400，不在这里做前置判断 */
  @Delete(':id')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  async delete(@Param('id') id: string) {
    await this.teamService.delete(id);
    return { message: '删除成功' };
  }

  /** 团队分页列表 */
  @Get('page')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  page(@Query() query: QueryTeamDto) {
    return this.teamService.page(query);
  }

  /** 当前用户所在团队（含担任负责人的），登录即可 */
  @Get('mine')
  listMine(@CurrentUser() user: AuthUser) {
    return this.teamService.listMine(user.userId);
  }

  /** 团队树；公开接口，供选择团队的下拉/树控件使用 */
  @Get('tree')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  getTree(@Query('rootOnly') rootOnly?: string) {
    return this.teamService.getTree(rootOnly === 'true');
  }

  /** 团队详情（含成员数） */
  @Get(':id')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  getDetail(@Param('id') id: string) {
    return this.teamService.getDetail(id);
  }

  /**
   * 批量添加成员。
   * 请求体直接是 userId 数组，重复添加同一个人不会报错（service 内做幂等）。
   */
  @Post(':id/members')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  addMembers(@Param('id') id: string, @Body() userIds: string[]) {
    return this.teamService.addMembers(id, userIds);
  }

  /** 批量移除成员；不在团队里的用户会被静默忽略 */
  @Delete(':id/members')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  removeMembers(@Param('id') id: string, @Body() userIds: string[]) {
    return this.teamService.removeMembers(id, userIds);
  }

  /** 成员列表（已 join 用户表并过滤已删除用户） */
  @Get(':id/members')
  @Roles(RoleCode.ADMIN)
  @RequirePermission('system:team')
  listMembers(@Param('id') id: string) {
    return this.teamService.listMembers(id);
  }
}
