import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Category } from '../categories/category.entity.js';
import { ErrorHandleService } from '../common/error-handle.service.js';
import { AdminProductsController } from './admin-products.controller.js';
import { Product } from './product.entity.js';
import { ProductsService } from './product.service.js';
import { ProductsController } from './products.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Product, Category])],
  controllers: [ProductsController, AdminProductsController],
  providers: [ProductsService, ErrorHandleService],
  exports: [ProductsService],
})
export class ProductsModule {}
