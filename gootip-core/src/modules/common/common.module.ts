import { Global, Module } from '@nestjs/common';

import { ErrorHandleService } from './error-handle.service.js';

@Global()
@Module({
  providers: [ErrorHandleService],
  exports: [ErrorHandleService],
})
export class CommonModule {}
