import { Global, Module } from '@nestjs/common';
import { RustfsService } from './rustfs.service.js';

@Global()
@Module({
  providers: [RustfsService],
  exports: [RustfsService],
})
export class StorageModule {}
