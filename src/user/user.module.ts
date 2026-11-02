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
  ],
  controllers: [UserController, RoleController, PermissionController],
  providers: [UserService, RoleService, PermissionService],
  exports: [UserService, RoleService, PermissionService],
})
export class UserModule {}
