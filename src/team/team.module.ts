import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamEntity } from './entities/team.entity.js';
import { TeamMemberEntity } from './entities/team-member.entity.js';
import { UserEntity } from '../user/entities/user.entity.js';
import { TeamService } from './team.service.js';
import { TeamController } from './team.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([TeamEntity, TeamMemberEntity, UserEntity])],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
