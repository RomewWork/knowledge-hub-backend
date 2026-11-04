import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Public } from './auth/decorators/public.decorator.js';

/**
 * 根控制器：只提供健康检查/欢迎接口。
 *
 * 注意：@Controller() 未声明路径，项目也没设置全局前缀，所以它的真实路径就是 `GET /`。
 */
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 健康检查：@Public 跳过全局 JWT 守卫，供探针/负载均衡匿名访问 */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
