import { describe, expect, it } from 'vitest';

import { ProductStatuses } from '../src/helpers/products.js';
import { AdminProductListQueryDto } from '../src/modules/products/dto/admin-product-list-query.dto.js';
import { CreateProductDto } from '../src/modules/products/dto/create-product.dto.js';
import { ProductListQueryDto } from '../src/modules/products/dto/product-list-query.dto.js';
import { UpdateProductDto } from '../src/modules/products/dto/update-product.dto.js';
import { createValidationPipe } from '../src/validation.pipe.js';

const pipe = createValidationPipe();
const categoryId = 'bbd3c83a-b583-4cb3-86e5-4eccfcd8a45d';
const createMetadata = { type: 'body' as const, metatype: CreateProductDto };

describe('product DTO validation', () => {
  it.each([CreateProductDto, UpdateProductDto])(
    'validates SKU length after normalization in %s',
    async (metatype) => {
      const metadata = { type: 'body' as const, metatype };
      const input = { name: 'Product', categoryId, priceUsd: '1.00' };

      await expect(
        pipe.transform({ ...input, sku: `  ${'ß'.repeat(50)}  ` }, metadata),
      ).resolves.toMatchObject({ sku: 'SS'.repeat(50) });

      await expect(
        pipe.transform({ ...input, sku: 'ß'.repeat(51) }, metadata),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  it('accepts and trims valid product input without coercing money or stock', async () => {
    await expect(
      pipe.transform(
        {
          sku: ' SKU-1 ',
          name: ' Product ',
          categoryId,
          priceUsd: '0.01',
          discountPercentage: '50.00',
          stock: 0,
          images: [],
        },
        createMetadata,
      ),
    ).resolves.toMatchObject({ sku: 'SKU-1', name: 'Product' });
  });

  it.each([
    { priceUsd: 1 },
    { priceUsd: '1.001' },
    { priceUsd: '0' },
    { discountPercentage: '100.01' },
    { stock: 1.5 },
    { images: ['http://example.com/image.png'] },
    { status: ProductStatuses.PUBLISHED },
  ])('rejects invalid create fields: %o', async (override) => {
    await expect(
      pipe.transform(
        {
          sku: 'SKU-1',
          name: 'Product',
          categoryId,
          priceUsd: '1.00',
          ...override,
        },
        createMetadata,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('validates list query filters and rejects public status overrides', async () => {
    await expect(
      pipe.transform(
        { minPrice: '1.00', maxPrice: '2.00', inStock: 'false' },
        { type: 'query', metatype: ProductListQueryDto },
      ),
    ).resolves.toMatchObject({ inStock: 'false' });

    await expect(
      pipe.transform(
        { minPrice: '2.00', maxPrice: '1.00' },
        { type: 'query', metatype: ProductListQueryDto },
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      pipe.transform(
        { status: ProductStatuses.DRAFT },
        { type: 'query', metatype: ProductListQueryDto },
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      pipe.transform(
        { status: ProductStatuses.DRAFT },
        { type: 'query', metatype: AdminProductListQueryDto },
      ),
    ).resolves.toMatchObject({ status: ProductStatuses.DRAFT });
  });

  it('makes create fields optional for patches while only allowing null description', async () => {
    const metadata = { type: 'body' as const, metatype: UpdateProductDto };
    await expect(
      pipe.transform({ name: 'Updated' }, metadata),
    ).resolves.toMatchObject({
      name: 'Updated',
    });
    await expect(
      pipe.transform({ description: null }, metadata),
    ).resolves.toMatchObject({
      description: null,
    });
    for (const value of [
      { sku: null },
      { priceUsd: null },
      { discountPercentage: null },
      { stock: null },
      { images: null },
      { status: null },
    ]) {
      await expect(pipe.transform(value, metadata)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});
