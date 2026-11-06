import { describe, expect, it } from 'vitest';

import { calculateFinalPriceUsd } from '../src/modules/products/product-pricing.js';

describe('product final price calculation', () => {
  it.each([
    ['10.00', '0.00', '10.00'],
    ['10.00', '1.00', '9.90'],
    ['10.00', '12.34', '8.77'],
    ['0.01', '50.00', '0.01'],
    ['9999999999.99', '100.00', '0.00'],
  ])('calculates %s with %s%% discount as %s', (price, discount, result) => {
    expect(calculateFinalPriceUsd(price, discount)).toBe(result);
  });
});
