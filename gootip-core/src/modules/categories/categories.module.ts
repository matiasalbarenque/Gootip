import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ErrorHandleService } from '../common/error-handle.service.js';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { Category } from './category.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService, ErrorHandleService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
