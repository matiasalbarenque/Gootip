import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { PaginatedResponse } from '../../helpers/pagination/pagination-response.js';
import { ProductStatuses } from '../../helpers/products.js';
import { databaseError, normalizeDecimal } from '../../helpers/utils.js';
import { Category } from '../categories/category.entity.js';
import { ErrorHandleService } from '../common/error-handle.service.js';
import { AdminProductListQueryDto } from './dto/admin-product-list-query.dto.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductListQueryDto } from './dto/product-list-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { toProductResponse } from './helpers/products.js';
import { Product } from './product.entity.js';
import type { ProductResponse } from './typings/products.js';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    @InjectRepository(Category)
    private readonly categories: Repository<Category>,
    private readonly errorHandleService: ErrorHandleService,
  ) {}

  async findOne(id: string): Promise<ProductResponse> {
    return toProductResponse(await this.findEntity(id));
  }

  async findPublishedOne(id: string): Promise<ProductResponse> {
    const product = await this.products.findOneBy({
      id,
      status: ProductStatuses.PUBLISHED,
    });
    if (!product) throw new NotFoundException('Product not found');
    return toProductResponse(product);
  }

  async listPublic(
    query: ProductListQueryDto,
  ): Promise<PaginatedResponse<ProductResponse>> {
    return this.list(query, true);
  }

  async listAdmin(
    query: AdminProductListQueryDto,
  ): Promise<PaginatedResponse<ProductResponse>> {
    return this.list(query, false);
  }

  async create(input: CreateProductDto): Promise<ProductResponse> {
    const category = await this.categories.findOneBy({ id: input.categoryId });
    if (!category) throw new NotFoundException('Category not found');

    const product = this.products.create({
      sku: input.sku.trim().toUpperCase(),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      categoryId: input.categoryId,
      priceUsd: normalizeDecimal(input.priceUsd),
      discountPercentage: normalizeDecimal(input.discountPercentage ?? '0'),
      stock: input.stock ?? 0,
      images: input.images ?? [],
      status: ProductStatuses.DRAFT,
    });
    try {
      return toProductResponse(await this.products.save(product));
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  async update(id: string, input: UpdateProductDto): Promise<ProductResponse> {
    const changes: Partial<Product> = {};
    if (input.sku !== undefined) changes.sku = input.sku.trim().toUpperCase();
    if (input.name !== undefined) changes.name = input.name.trim();
    if (input.description !== undefined) {
      changes.description = input.description?.trim() || null;
    }
    if (input.categoryId !== undefined) {
      changes.categoryId = input.categoryId;
    }
    if (input.priceUsd !== undefined) {
      changes.priceUsd = normalizeDecimal(input.priceUsd);
    }
    if (input.discountPercentage !== undefined) {
      changes.discountPercentage = normalizeDecimal(input.discountPercentage);
    }
    if (input.stock !== undefined) changes.stock = input.stock;
    if (input.images !== undefined) changes.images = input.images;
    if (input.status !== undefined) changes.status = input.status;

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('At least one property must be provided');
    }

    await this.findEntity(id);
    if (
      input.categoryId !== undefined &&
      !(await this.categories.findOneBy({ id: input.categoryId }))
    ) {
      throw new NotFoundException('Category not found');
    }

    try {
      const result = await this.products.update({ id }, changes);
      if (result.affected === 0)
        throw new NotFoundException('Product not found');
      return await this.findOne(id);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  private async findEntity(id: string): Promise<Product> {
    const product = await this.products.findOneBy({ id });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async list(
    query: ProductListQueryDto | AdminProductListQueryDto,
    publicOnly: boolean,
  ): Promise<PaginatedResponse<ProductResponse>> {
    const builder = this.products.createQueryBuilder('product').where('1 = 1');
    if (publicOnly) {
      builder.andWhere('product.status = :publishedStatus', {
        publishedStatus: ProductStatuses.PUBLISHED,
      });
    } else if ('status' in query && query.status !== undefined) {
      builder.andWhere('product.status = :status', { status: query.status });
    }

    if (query.search !== undefined) {
      const escaped = query.search.replace(/[\\%_]/g, '\\$&');
      const predicate =
        "(product.name ILIKE :search ESCAPE '\\' OR product.sku ILIKE :search ESCAPE '\\')";
      builder.andWhere(predicate, { search: `%${escaped}%` });
    }
    if (query.categoryId !== undefined) {
      builder.andWhere('product.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }
    if (query.minPrice !== undefined) {
      builder.andWhere(
        'round(product.price_usd * (100 - product.discount_percentage) / 100, 2) >= :minPrice',
        { minPrice: query.minPrice },
      );
    }
    if (query.maxPrice !== undefined) {
      builder.andWhere(
        'round(product.price_usd * (100 - product.discount_percentage) / 100, 2) <= :maxPrice',
        { maxPrice: query.maxPrice },
      );
    }
    if (query.inStock !== undefined) {
      builder.andWhere(
        query.inStock === 'true' ? 'product.stock > 0' : 'product.stock = 0',
      );
    }

    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder?.toUpperCase() ?? 'DESC';
    const sortExpressions = {
      createdAt: 'product.created_at',
      name: 'product.name',
      price:
        'round(product.price_usd * (100 - product.discount_percentage) / 100, 2)',
    } as const;
    const [products, total] = await builder
      .orderBy(sortExpressions[sortBy], sortOrder as 'ASC' | 'DESC')
      .addOrderBy('product.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    return {
      data: products.map(toProductResponse),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  private handleWriteError(error: unknown): never {
    const dbError = databaseError(error);
    if (dbError?.code === '23505') {
      throw new ConflictException('A product with this SKU already exists');
    }
    if (
      dbError?.code === '23503' &&
      dbError.constraint === 'FK_products_category_id'
    ) {
      throw new NotFoundException('Category not found');
    }
    if (dbError?.code === '23514') {
      throw new BadRequestException('Invalid product data');
    }
    this.errorHandleService.errorHandle(error);
  }
}
