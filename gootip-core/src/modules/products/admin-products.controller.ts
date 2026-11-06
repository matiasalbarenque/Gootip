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

import { RequireRoles } from '../../config/auth/auth.js';
import { ROLES } from '../../helpers/app.js';
import { AdminProductListQueryDto } from './dto/admin-product-list-query.dto.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductsService } from './product.service.js';

@Controller('admin/products')
@RequireRoles(ROLES.EDITOR, ROLES.ADMIN)
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() query: AdminProductListQueryDto) {
    return this.products.listAdmin(query);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.findOne(id);
  }

  @Post()
  create(@Body() input: CreateProductDto) {
    return this.products.create(input);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateProductDto,
  ) {
    return this.products.update(id, input);
  }
}
