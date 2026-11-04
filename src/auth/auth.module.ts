import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { EmailService } from './email.service.js';
import { EmailActivationService } from './email-activation.service.js';
import { JwtStrategy } from './jwt.startegy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { PermissionsGuard } from './permissions.guard.js';
import { MailerModule } from '@nestjs-modules/mailer';
import { PasswordResetService } from './password-reset.service.js';
import { UserModule } from '../user/user.module.js';

/**
 * 认证模块装配：注册 JWT / Passport / Mailer，并把三个守卫挂成全局 APP_GUARD。
 *
 * 依赖 ConfigService（JWT_SECRET 读取）、UserModule（用户与角色查询）、MailerModule（transport 在 AppModule 配置）。
 *
 * 坑与取舍：
 * - 三个守卫按 providers 声明顺序执行：JwtAuthGuard → RolesGuard → PermissionsGuard；
 *   顺序调乱后两个就读不到 request.user，标了 @Roles / @RequirePermission 的接口会 403。
 * - JwtModule 只配了 secret，没有 signOptions.expiresIn；过期时间由 AuthService 每次签名时传入，改默认值要去 auth.service。
 * - 守卫是全局的，业务模块不要重复 @UseGuards；放行靠 @Public()。
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    MailerModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
      }),
    }),
    UserModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    EmailService,
    EmailActivationService,
    PasswordResetService,
    JwtStrategy,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
  exports: [AuthService, UserModule],
})
export class AuthModule {}
