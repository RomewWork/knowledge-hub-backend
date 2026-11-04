import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamEntity } from './entities/team.entity.js';
import { TeamMemberEntity } from './entities/team-member.entity.js';
import { UserEntity } from '../user/entities/user.entity.js';
import { TeamService } from './team.service.js';
import { TeamController } from './team.controller.js';

/**
 * 团队模块
 *
 * 职责：注册团队相关的控制器与服务，并把三个实体交给 TypeORM 仓储。
 *
 * 关键依赖：TypeOrmModule.forFeature 提供 TeamEntity / TeamMemberEntity / UserEntity 的 Repository。
 *
 * 坑与取舍：
 * 1. 这里额外注册了 UserEntity，因为 addMembers 要校验用户存在、listMembers 要 join 用户表，
 *    但用户模块自己的仓储配置不会被别的模块共享。
 * 2. 对外导出 TeamService，供用户/文档等模块反查团队归属；控制器只在内部用。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TeamEntity, TeamMemberEntity, UserEntity])],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
