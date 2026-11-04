import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

/**
 * 应用入口：创建 Nest 实例、装全局校验管道并监听端口。
 *
 * 注意：
 * - 这里没有调用 setGlobalPrefix，接口路径就是各 controller 上声明的路径（如 GET /、/documents），
 *   前端/网关不要额外拼前缀。
 * - 项目是 ESM，所有相对 import 必须保留 .js 后缀，新增文件时别改成无后缀写法。
 * - 鉴权由 AuthModule 里的全局 guard 负责，本文件只处理启动与全局管道。
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    // whitelist 丢弃 DTO 未声明的字段；forbidNonWhitelisted 让多余字段直接 400；
    // transform 负责把 query/path 的字符串按 DTO 类型转换（如 number）。
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  // 端口优先读环境变量 PORT，未配置时回退 3000
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
