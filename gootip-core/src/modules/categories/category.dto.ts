import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { PaginationDto } from '../../helpers/pagination/pagination.dto.js';
import { trimString } from '../../helpers/utils.js';

export class CreateCategoryDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(5000)
  description?: string | null;
}

export class UpdateCategoryDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(5000)
  description?: string | null;
}

export class ListCategoriesDto extends PaginationDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  search?: string;
}
