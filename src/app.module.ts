import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DocumentModule } from './document/document.module.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { MailerModule } from '@nestjs-modules/mailer';
import { DocumentEntity } from './document/entities/document.entity.js';
import { StorageModule } from './storage/storage.module.js';
import { MqModule } from './mq/mq.module.js';
import { PipelineModule } from './pipeline/pipeline.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TeamModule } from './team/team.module.js';
import { DocumentReviewEntity } from './document/entities/document.review.entity.js';
import { UserEntity } from './user/entities/user.entity.js';
import { RoleEntity } from './user/entities/role.entity.js';
import { UserRoleEntity } from './user/entities/user-role.entity.js';
import { PermissionEntity } from './user/entities/permission.entity.js';
import { RolePermissionEntity } from './user/entities/role-permission.entity.js';
import { UserPermissionEntity } from './user/entities/user-permission.entity.js';
import { TeamEntity } from './team/entities/team.entity.js';
import { TeamMemberEntity } from './team/entities/team-member.entity.js';
import { AuthModule } from './auth/auth.module.js';
import { SearchModule } from './search/search.module.js';
import { GraphModule } from './graph/graph.module.js';

/**
 * 根模块：集中装配配置、PostgreSQL / MongoDB、邮件、Redis 以及各业务模块。
 *
 * 注意：
 * - ConfigModule 设为全局，其它模块无需重复 import 就能注入 ConfigService。
 * - TypeORM 的 entities 必须在这里显式登记（或在特性模块 forFeature），否则 @InjectRepository
 *   拿不到实体元数据，应用启动即报错；新增实体时记得同步下面这份清单。
 * - synchronize 固定为 false：表结构由 init-scripts/postgresql/init.sql 维护，
 *   生产环境绝不能让 TypeORM 自动改表。
 */
@Module({
  imports: [
    // 全局配置：加载 .env，任意模块可直接注入 ConfigService
    ConfigModule.forRoot({ isGlobal: true }),
    // 业务主库：用户 / 角色 / 权限 / 团队 / 文档元数据
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'user'),
        password: config.get<string>('POSTGRES_PASSWORD', '123456'),
        database: config.get<string>('POSTGRES_DB', 'knowledge_hub'),
        // 每个 entity 都要登记，@InjectRepository 才能按实体找到对应仓储
        entities: [
          DocumentEntity,
          DocumentReviewEntity,
          UserEntity,
          RoleEntity,
          UserRoleEntity,
          PermissionEntity,
          RolePermissionEntity,
          UserPermissionEntity,
          TeamEntity,
          TeamMemberEntity,
        ],
        // 生产必须 false：禁止启动时自动同步表结构，避免误改甚至丢数据
        synchronize: false,
      }),
    }),
    // 文档正文等非结构化内容存 MongoDB（见 document-content.schema）
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>(
          'MONGO_URI',
          'mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin',
        ),
      }),
    }),
    DocumentModule,
    StorageModule,
    MqModule,
    PipelineModule,
    AuthModule,
    // 邮件：注册激活、找回密码验证码等，账号密码全部来自环境变量
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        transport: {
          host: configService.get<string>('MAIL_HOST'),
          port: Number(configService.get<string>('MAIL_PORT')),
          secure: configService.get<string>('MAIL_SECURE') === 'true',
          auth: {
            user: configService.get<string>('MAIL_USER'),
            pass: configService.get<string>('MAIL_PASS'),
          },
        },
        defaults: {
          from: configService.get<string>('MAIL_FROM'),
        },
      }),
    }),
    RedisModule,
    TeamModule,
    SearchModule,
    GraphModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
