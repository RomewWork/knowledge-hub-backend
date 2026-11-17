import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { MailerModule } from '@nestjs-modules/mailer';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DocumentModule } from './document/document.module.js';
import { DocumentEntity } from './document/entities/document.entity.js';
import { DocumentReviewEntity } from './document/entities/document.review.entity.js';
import { AuthModule } from './auth/auth.module.js';
import { UserEntity } from './user/entities/user.entity.js';
import { RoleEntity } from './user/entities/role.entity.js';
import { UserRoleEntity } from './user/entities/user-role.entity.js';
import { PermissionEntity } from './user/entities/permission.entity.js';
import { RolePermissionEntity } from './user/entities/role-permission.entity.js';
import { UserPermissionEntity } from './user/entities/user-permission.entity.js';
import { TeamEntity } from './team/entities/team.entity.js';
import { TeamMemberEntity } from './team/entities/team-member.entity.js';
import { TeamModule } from './team/team.module.js';
import { RedisModule } from './redis/redis.module.js';
import { MqModule } from './mq/mq.module.js';
import { PipelineModule } from './pipeline/pipeline.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SearchModule } from './search/search.module.js';
import { AiModule } from './ai/ai.module.js';
import { GraphModule } from './graph/graph.module.js';
import { AiSessionEntity } from './ai/entities/ai-session.entity.js';
import { AiMessageEntity } from './ai/entities/ai-message.entity.js';
import { CategoryEntity } from './document/entities/category.entity.js';
import { CommentEntity } from './document/entities/comment.entity.js';
import { DocumentLikeEntity } from './document/entities/document-like.entity.js';
import { DocumentFavoriteEntity } from './document/entities/document-favorite.entity.js';
import { DocumentShareEntity } from './document/entities/document-share.entity.js';
import { DocumentVersionEntity } from './document/entities/document-version.entity.js';
import { NotificationEntity } from './notification/notification.entity.js';
import { NotificationModule } from './notification/notification.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
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
    PipelineModule,
    MqModule,
    StorageModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'user'),
        password: config.get<string>('POSTGRES_PASSWORD', '123456'),
        database: config.get<string>('POSTGRES_DB', 'knowledge_hub'),
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
          AiSessionEntity,
          AiMessageEntity,
          CategoryEntity,
          CommentEntity,
          DocumentLikeEntity,
          DocumentFavoriteEntity,
          DocumentShareEntity,
          DocumentVersionEntity,
          NotificationEntity,
        ],
        synchronize: false,
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>(
          'MONGO_URI',
          'mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin',
        ),
      }),
    }),
    NotificationModule,
    DocumentModule,
    AuthModule,
    TeamModule,
    SearchModule,
    AiModule,
    GraphModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
