import { Global, Module } from '@nestjs/common';
import { RustfsService } from './rustfs.service.js';

/**
 * 对象存储模块（RustFS，S3 兼容）
 *
 * `@Global()` 让 RustfsService 在任何模块里都能直接注入，不用逐个 imports。
 * 因为文档模块（上传原件）和解析器（可能的图片上传）都要用它，
 * 逐模块 import 只会制造重复声明。
 */
@Global()
@Module({
  providers: [RustfsService],
  exports: [RustfsService],
})
export class StorageModule {}
