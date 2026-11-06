import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import { ProductStatuses } from '../src/helpers/products.js';
import { Category } from '../src/modules/categories/category.entity.js';
import { ErrorHandleService } from '../src/modules/common/error-handle.service.js';
import { AdminProductListQueryDto } from '../src/modules/products/dto/admin-product-list-query.dto.js';
import { ProductListQueryDto } from '../src/modules/products/dto/product-list-query.dto.js';
import { Product } from '../src/modules/products/product.entity.js';
import { ProductsService } from '../src/modules/products/product.service.js';

const createQueryBuilder = (rows: Product[] = [], total = 0) => {
  const builder = {
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    addOrderBy: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getManyAndCount: vi.fn().mockResolvedValue([rows, total]),
  };
  return builder;
};

const createService = (builder: ReturnType<typeof createQueryBuilder>) =>
  new ProductsService(
    {
      createQueryBuilder: vi.fn(() => builder),
    } as unknown as Repository<Product>,
    {} as Repository<Category>,
    {} as ErrorHandleService,
  );

describe('ProductsService list queries', () => {
  it('combines public filters with mandatory publication and safe pagination', async () => {
    const builder = createQueryBuilder([], 7);
    const service = createService(builder);
    const query = Object.assign(new ProductListQueryDto(), {
      page: 3,
      limit: 2,
      search: '50%_off',
      categoryId: 'bbd3c83a-b583-4cb3-86e5-4eccfcd8a45d',
      minPrice: '1.00',
      maxPrice: '25.50',
      inStock: 'false' as const,
      sortBy: 'price' as const,
      sortOrder: 'asc' as const,
    });

    const result = await service.listPublic(query);

    expect(builder.andWhere).toHaveBeenNthCalledWith(
      1,
      'product.status = :publishedStatus',
      { publishedStatus: ProductStatuses.PUBLISHED },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      "(product.name ILIKE :search ESCAPE '\\' OR product.sku ILIKE :search ESCAPE '\\')",
      { search: '%50\\%\\_off%' },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'product.categoryId = :categoryId',
      { categoryId: query.categoryId },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'round(product.price_usd * (100 - product.discount_percentage) / 100, 2) >= :minPrice',
      { minPrice: '1.00' },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'round(product.price_usd * (100 - product.discount_percentage) / 100, 2) <= :maxPrice',
      { maxPrice: '25.50' },
    );
    expect(builder.andWhere).toHaveBeenCalledWith('product.stock = 0');
    expect(builder.orderBy).toHaveBeenCalledWith(
      'round(product.price_usd * (100 - product.discount_percentage) / 100, 2)',
      'ASC',
    );
    expect(builder.addOrderBy).toHaveBeenCalledWith('product.id', 'ASC');
    expect(builder.skip).toHaveBeenCalledWith(4);
    expect(builder.take).toHaveBeenCalledWith(2);
    expect(result.meta).toEqual({ page: 3, limit: 2, total: 7, totalPages: 4 });
  });

  it('applies admin status filtering but never applies it to public queries', async () => {
    const builder = createQueryBuilder();
    const service = createService(builder);
    const query = Object.assign(new AdminProductListQueryDto(), {
      status: ProductStatuses.ARCHIVED,
    });

    await service.listAdmin(query);

    expect(builder.andWhere).toHaveBeenCalledWith('product.status = :status', {
      status: ProductStatuses.ARCHIVED,
    });
    expect(builder.getManyAndCount).toHaveBeenCalledOnce();
  });
});
