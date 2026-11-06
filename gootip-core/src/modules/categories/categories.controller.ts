import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Public, RequireRoles } from '../../config/auth/auth.js';
import { ROLES } from '../../helpers/app.js';
import { ErrorHandleService } from '../common/error-handle.service.js';
import { CategoriesService } from './categories.service.js';
import {
  CreateCategoryDto,
  ListCategoriesDto,
  UpdateCategoryDto,
} from './category.dto.js';

@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly errorHandleService: ErrorHandleService,
  ) {}

  @Get()
  @Public()
  list(@Query() query: ListCategoriesDto) {
    return this.categories.list(query);
  }

  @Get(':id')
  @Public()
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @RequireRoles(ROLES.EDITOR, ROLES.ADMIN)
  async create(@Body() input: CreateCategoryDto) {
    try {
      return await this.categories.create(input);
    } catch (error) {
      this.errorHandleService.errorHandle(error);
    }
  }

  @Patch(':id')
  @RequireRoles(ROLES.EDITOR, ROLES.ADMIN)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateCategoryDto,
  ) {
    try {
      return await this.categories.update(id, input);
    } catch (error) {
      this.errorHandleService.errorHandle(error);
    }
  }
}
