import { Transform } from 'class-transformer';
import {
  IsInt,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

const parseInteger = ({ value }: { value: unknown }): unknown => {
  // Keep non-digit values unchanged so class-validator can report them as invalid.
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return value;
  return Number(value);
};

@ValidatorConstraint({ name: 'safeOffset', async: false })
class SafeOffset implements ValidatorConstraintInterface {
  validate(_: unknown, args?: ValidationArguments): boolean {
    const pagination = args?.object as PaginationDto | undefined;
    return (
      pagination !== undefined &&
      Number.isSafeInteger((pagination.page - 1) * pagination.limit)
    );
  }

  defaultMessage(): string {
    return 'page and limit produce an offset outside the safe integer range';
  }
}

export class PaginationDto {
  @Transform(parseInteger)
  @IsInt()
  @Min(1)
  @Max(10_000)
  @Validate(SafeOffset)
  page = 1;

  @Transform(parseInteger)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
