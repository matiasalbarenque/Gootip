import { IsString } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { PaginationDto } from '../src/helpers/pagination/pagination.dto.js';
import { ListCategoriesDto } from '../src/modules/categories/category.dto.js';
import { createValidationPipe } from '../src/validation.pipe.js';

class ExampleDto {
  @IsString()
  name!: string;
}

describe('shared request validation', () => {
  it('accepts page 10000 and rejects pages above the maximum', async () => {
    const pipe = createValidationPipe();
    const metadata = { type: 'query' as const, metatype: PaginationDto };

    await expect(
      pipe.transform({ page: '10000', limit: '100' }, metadata),
    ).resolves.toMatchObject({ page: 10_000, limit: 100 });

    for (const page of ['10001', '9007199254740992']) {
      await expect(
        pipe.transform({ page, limit: '1' }, metadata),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('keeps search validation specific to categories', async () => {
    const pipe = createValidationPipe();
    const metadata = { type: 'query' as const, metatype: ListCategoriesDto };

    await expect(
      pipe.transform({ search: `  ${'a'.repeat(120)}  ` }, metadata),
    ).resolves.toMatchObject({ page: 1, limit: 20, search: 'a'.repeat(120) });

    for (const search of ['a'.repeat(121), '   ', ['a', 'b']]) {
      await expect(pipe.transform({ search }, metadata)).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(
      pipe.transform(
        { search: 'a' },
        { type: 'query', metatype: PaginationDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown properties and malformed values', async () => {
    const pipe = createValidationPipe();
    const metadata = { type: 'body' as const, metatype: ExampleDto };

    await expect(
      pipe.transform({ name: 'valid', extra: true }, metadata),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(pipe.transform({ name: 12 }, metadata)).rejects.toMatchObject({
      status: 400,
    });
  });
});
