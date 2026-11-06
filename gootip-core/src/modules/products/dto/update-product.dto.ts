import { PartialType } from '@nestjs/mapped-types';
import { IsIn, ValidateIf } from 'class-validator';

import { ProductStatuses } from '../../../helpers/products.js';
import type { ProductStatus } from '../typings/products.js';
import { CreateProductDto } from './create-product.dto.js';

export class UpdateProductDto extends PartialType(CreateProductDto, {
  skipNullProperties: false,
}) {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(Object.values(ProductStatuses))
  status?: ProductStatus;
}
