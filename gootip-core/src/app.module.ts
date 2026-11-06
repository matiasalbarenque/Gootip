import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './config/auth/auth.guard.js';
import { DatabaseModule } from './config/database/database.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { ProductsModule } from './modules/products/products.module.js';

@Module({
  imports: [DatabaseModule, CategoriesModule, ProductsModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
