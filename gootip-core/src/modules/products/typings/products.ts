import { ProductStatuses } from '../../../helpers/products.js';

export type ProductStatus =
  (typeof ProductStatuses)[keyof typeof ProductStatuses];

export type ProductResponse = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  categoryId: string;
  priceUsd: string;
  discountPercentage: string;
  finalPriceUsd: string;
  stock: number;
  images: string[];
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
};
