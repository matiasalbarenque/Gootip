import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { PaginationDto } from '../../../helpers/pagination/pagination.dto.js';
import { trimString } from '../../../helpers/utils.js';

// Matches prices like 123, 123.4, 123.45, with up to 10 digits before the decimal point.
const pricePattern = /^\d{1,10}(?:\.\d{1,2})?$/;

// Converts a decimal price string (for example, "12.34") into integer cents so it can be compared precisely.
const decimalToCents = (value: string): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
};

@ValidatorConstraint({ name: 'minPriceNotAboveMaxPrice', async: false })
class MinPriceNotAboveMaxPrice implements ValidatorConstraintInterface {
  validate(_: unknown, args?: ValidationArguments): boolean {
    const query = args?.object as ProductListQueryDto | undefined;
    if (query?.minPrice !== undefined && !pricePattern.test(query.minPrice)) {
      return true;
    }
    if (query?.maxPrice !== undefined && !pricePattern.test(query.maxPrice)) {
      return true;
    }
    return (
      query?.minPrice === undefined ||
      query?.maxPrice === undefined ||
      decimalToCents(query.minPrice) <= decimalToCents(query.maxPrice)
    );
  }

  defaultMessage(): string {
    return 'minPrice must not exceed maxPrice';
  }
}

export class ProductListQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @Matches(pricePattern)
  @Validate(MinPriceNotAboveMaxPrice)
  minPrice?: string;

  @IsOptional()
  @IsString()
  @Matches(pricePattern)
  maxPrice?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  inStock?: 'true' | 'false';

  @IsOptional()
  @IsIn(['createdAt', 'name', 'price'])
  sortBy?: 'createdAt' | 'name' | 'price';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
