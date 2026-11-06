import { IsIn, IsOptional } from 'class-validator';

import { ProductStatuses } from '../../../helpers/products.js';
import type { ProductStatus } from '../typings/products.js';
import { ProductListQueryDto } from './product-list-query.dto.js';

export class AdminProductListQueryDto extends ProductListQueryDto {
  @IsOptional()
  @IsIn(Object.values(ProductStatuses))
  status?: ProductStatus;
}
