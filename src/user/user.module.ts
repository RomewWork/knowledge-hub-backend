import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service.js';
import { RoleService } from './role.service.js';
import { PermissionService } from './permission.service.js';
import { UserController } from './user.controller.js';
import { RoleController } from './role.controller.js';
import { PermissionController } from './permission.controller.js';
import { UserEntity } from './entities/user.entity.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { PermissionEntity } from './entities/permission.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { UserPermissionEntity } from './entities/user-permission.entity.js';
import { TeamModule } from '../team/team.module.js';

/**
 * 用户模块：用户 / 角色 / 权限三块业务的实体注册、控制器与服务
 *
 * - 三个控制器统一在本模块注册，路由前缀分别是 /users、/roles、/permissions
 * - 除用户、角色、权限及两张关联表外，还 forFeature 了 DocumentEntity：
 *   UserService.getUserStatistics 要按 authorId 聚合文档数，仓储必须在同一模块内可见
 * - 三个 Service 都 export：AuthModule 导入本模块后复用 UserService 完成登录、刷新与权限码组装
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      RoleEntity,
      UserRoleEntity,
      DocumentEntity,
      PermissionEntity,
      RolePermissionEntity,
      UserPermissionEntity,
    ]),
    TeamModule,
  ],
  controllers: [UserController, RoleController, PermissionController],
  providers: [UserService, RoleService, PermissionService],
  exports: [UserService, RoleService, PermissionService],
})
export class UserModule {}
