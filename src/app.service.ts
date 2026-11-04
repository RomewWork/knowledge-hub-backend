import { Injectable } from '@nestjs/common';

/** 根模块基础服务：目前只给根控制器返回一句欢迎语，健康检查用 */
@Injectable()
export class AppService {
  /** 返回固定欢迎文本 */
  getHello(): string {
    return 'Hello World!';
  }
}
