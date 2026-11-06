import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductStatuses } from '../src/helpers/products.js';
import { Category } from '../src/modules/categories/category.entity.js';
import { ErrorHandleService } from '../src/modules/common/error-handle.service.js';
import { Product } from '../src/modules/products/product.entity.js';
import { ProductsService } from '../src/modules/products/product.service.js';

const categoryId = 'bbd3c83a-b583-4cb3-86e5-4eccfcd8a45d';
const productId = '178a363a-8b25-4217-81b0-891151674db0';
const createdAt = new Date('2026-10-28T12:00:00.000Z');

const product = (overrides: Partial<Product> = {}): Product => ({
  id: productId,
  sku: 'SKU-1',
  name: 'Product',
  description: null,
  categoryId,
  priceUsd: '10.00',
  discountPercentage: '50.00',
  stock: 0,
  images: [],
  status: ProductStatuses.DRAFT,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

describe('ProductsService writes', () => {
  let service: ProductsService;
  let saved: Product;
  let products: {
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    findOneBy: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let categories: { findOneBy: ReturnType<typeof vi.fn> };
  let errorHandleService: { errorHandle: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    saved = product();
    products = {
      create: vi.fn((input) => input),
      save: vi.fn(async (input) => ({ ...product(), ...input })),
      findOneBy: vi.fn(async (where) =>
        where?.status !== undefined && where.status !== saved.status
          ? null
          : saved,
      ),
      update: vi.fn(async (_criteria, changes) => {
        saved = product({ ...saved, ...changes });
        return { affected: 1 };
      }),
    };
    categories = { findOneBy: vi.fn(async () => ({ id: categoryId })) };
    errorHandleService = {
      errorHandle: vi.fn(() => {
        throw new Error('unexpected');
      }),
    };
    service = new ProductsService(
      products as unknown as Repository<Product>,
      categories as unknown as Repository<Category>,
      errorHandleService as unknown as ErrorHandleService,
    );
  });

  it('normalizes product creation and returns exact derived prices', async () => {
    products.save.mockImplementation(async (input) =>
      product({ ...input, id: productId, createdAt, updatedAt: createdAt }),
    );
    const response = await service.create({
      sku: ' sku-1 ',
      name: ' Product ',
      categoryId,
      priceUsd: '10',
      discountPercentage: '50',
    });

    expect(products.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: 'SKU-1',
        name: 'Product',
        priceUsd: '10.00',
        discountPercentage: '50.00',
        stock: 0,
        images: [],
        status: ProductStatuses.DRAFT,
      }),
    );
    expect(response).toMatchObject({
      priceUsd: '10.00',
      discountPercentage: '50.00',
      finalPriceUsd: '5.00',
      createdAt: createdAt.toISOString(),
    });
  });

  it('updates only supplied fields, preserving unrelated current values', async () => {
    await service.update(productId, { name: ' Renamed ' });

    expect(products.update).toHaveBeenCalledWith(
      { id: productId },
      { name: 'Renamed' },
    );
    expect(saved).toMatchObject({ sku: 'SKU-1', name: 'Renamed', stock: 0 });
  });

  it('looks up public details with the published predicate', async () => {
    saved = product({ status: ProductStatuses.PUBLISHED });
    await service.findPublishedOne(productId);
    expect(products.findOneBy).toHaveBeenCalledWith({
      id: productId,
      status: ProductStatuses.PUBLISHED,
    });

    saved = product();
    await expect(service.findPublishedOne(productId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects empty updates and missing categories', async () => {
    await expect(service.update(productId, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    categories.findOneBy.mockResolvedValue(null);
    await expect(
      service.create({
        sku: 'SKU',
        name: 'Product',
        categoryId,
        priceUsd: '1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps concurrent SKU and category constraint failures safely', async () => {
    products.save.mockRejectedValue({
      driverError: { code: '23505', constraint: 'UQ_products_sku_normalized' },
    });
    await expect(
      service.create({
        sku: 'SKU',
        name: 'Product',
        categoryId,
        priceUsd: '1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    products.save.mockRejectedValue({
      driverError: { code: '23503', constraint: 'FK_products_category_id' },
    });
    await expect(
      service.create({
        sku: 'SKU',
        name: 'Product',
        categoryId,
        priceUsd: '1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
