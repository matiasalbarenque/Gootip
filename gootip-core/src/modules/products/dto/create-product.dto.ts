import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { trimString } from '../../../helpers/utils.js';

// Matches a positive USD price: 1 to 10 digits, optional decimal with up to 2 places, and at least one non-zero digit.
const positivePricePattern = /^(?=.*[1-9])\d{1,10}(?:\.\d{1,2})?$/;
// Matches a discount percentage from 0 to 100, with up to 2 decimal places.
const discountPattern = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

export class CreateProductDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku!: string;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @IsUUID()
  categoryId!: string;

  @IsString()
  @Matches(positivePricePattern)
  priceUsd!: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(discountPattern)
  discountPercentage?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  stock?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @MaxLength(2048, { each: true })
  images?: string[];
}
