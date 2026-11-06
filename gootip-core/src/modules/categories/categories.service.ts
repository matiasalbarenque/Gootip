import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { PaginatedResponse } from '../../helpers/pagination/pagination-response.js';
import { databaseError } from '../../helpers/utils.js';
import { ErrorHandleService } from '../common/error-handle.service.js';
import {
  CreateCategoryDto,
  ListCategoriesDto,
  UpdateCategoryDto,
} from './category.dto.js';
import { Category } from './category.entity.js';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categories: Repository<Category>,
    private readonly errorHandleService: ErrorHandleService,
  ) {}

  async list(query: ListCategoriesDto): Promise<PaginatedResponse<Category>> {
    const builder = this.categories.createQueryBuilder('category');
    if (query.search !== undefined) {
      // Escape SQL LIKE wildcard characters so the search treats them as literal text.
      // Example: "100%_ready" becomes "100\\%\\_ready".
      const escaped = query.search.replace(/[\\%_]/g, '\\$&');
      // Filter categories by name using a case-insensitive search with the escaped value.
      builder.where("category.name ILIKE :search ESCAPE '\\'", {
        search: `%${escaped}%`,
      });
    }
    const [data, total] = await builder
      .orderBy('category.name', 'ASC')
      .addOrderBy('category.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async findOne(id: string): Promise<Category> {
    const category = await this.categories.findOneBy({ id });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async create(input: CreateCategoryDto): Promise<Category> {
    const category = this.categories.create({
      name: input.name,
      description: input.description?.trim() || null,
    });
    try {
      return await this.categories.save(category);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  async update(id: string, input: UpdateCategoryDto): Promise<Category> {
    if (input.name === undefined && input.description === undefined) {
      throw new BadRequestException('At least one property must be provided');
    }
    const category = await this.findOne(id);
    if (input.name !== undefined) category.name = input.name;
    if (input.description !== undefined) {
      category.description = input.description?.trim() || null;
    }
    try {
      return await this.categories.save(category);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  private handleWriteError(error: unknown): never {
    const dbError = databaseError(error);
    if (
      dbError?.code === '23505' &&
      dbError.constraint === 'UQ_categories_name_lower'
    ) {
      throw new ConflictException('A category with this name already exists');
    }
    this.errorHandleService.errorHandle(error);
  }
}
