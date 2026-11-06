import { normalizeDecimal } from '../../../helpers/utils.js';
import { calculateFinalPriceUsd } from '../product-pricing.js';
import { Product } from '../product.entity.js';
import { ProductResponse } from '../typings/products.js';

export const toProductResponse = (product: Product): ProductResponse => ({
  id: product.id,
  sku: product.sku,
  name: product.name,
  description: product.description,
  categoryId: product.categoryId,
  priceUsd: normalizeDecimal(product.priceUsd),
  discountPercentage: normalizeDecimal(product.discountPercentage),
  finalPriceUsd: calculateFinalPriceUsd(
    product.priceUsd,
    product.discountPercentage,
  ),
  stock: product.stock,
  images: product.images,
  status: product.status,
  createdAt: product.createdAt.toISOString(),
  updatedAt: product.updatedAt.toISOString(),
});
