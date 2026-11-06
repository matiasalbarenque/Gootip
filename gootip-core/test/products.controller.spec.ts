import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ROUTE, REQUIRED_ROLES } from '../src/config/auth/auth.js';
import { ROLES } from '../src/helpers/app.js';
import { AdminProductsController } from '../src/modules/products/admin-products.controller.js';
import { ProductsController } from '../src/modules/products/products.controller.js';

describe('product controllers', () => {
  it('marks public product routes public regardless of caller role', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE, ProductsController)).toBe(true);
  });

  it('restricts all admin product routes to editor and admin', () => {
    expect(
      Reflect.getMetadata(REQUIRED_ROLES, AdminProductsController),
    ).toEqual([ROLES.EDITOR, ROLES.ADMIN]);
  });

  it('routes public detail through the published-only service method', async () => {
    const products = {
      findPublishedOne: vi.fn().mockResolvedValue({ id: 'p1' }),
    };
    const controller = new ProductsController(products as never);

    await expect(controller.findOne('p1')).resolves.toEqual({ id: 'p1' });
    expect(products.findPublishedOne).toHaveBeenCalledWith('p1');
  });
});
