import { describe, expect, it } from 'vitest';

import { exportCoreContracts } from '../scripts/export-contracts.js';

describe('Core contract exporter', () => {
  it('resolves inherited, mapped, enum, array, and UUID DTO fields', () => {
    const contracts = exportCoreContracts();
    const listProducts = contracts.find(
      (contract) =>
        contract.path === '/api/products' && contract.method === 'GET',
    );
    const updateProduct = contracts.find(
      (contract) =>
        contract.path === '/api/admin/products/:id' &&
        contract.method === 'PATCH',
    );
    const createProduct = contracts.find(
      (contract) =>
        contract.path === '/api/admin/products' && contract.method === 'POST',
    );

    expect(listProducts?.query).toMatchObject({
      page: { type: 'number', required: true, example: 1 },
      limit: { type: 'number', required: true, example: 1 },
      categoryId: { type: 'string', required: false },
    });
    expect(updateProduct?.parameters).toMatchObject({
      id: { example: '00000000-0000-4000-8000-000000000001' },
    });
    expect(updateProduct?.body).toMatchObject({
      status: { values: ['draft', 'published', 'archived'] },
      images: { type: 'array' },
    });
    expect(createProduct?.body).toMatchObject({
      priceUsd: { example: '12.34' },
      images: { example: ['https://example.invalid/image.jpg'] },
    });
    expect(createProduct?.body).toHaveProperty('categoryId');
  });
});
