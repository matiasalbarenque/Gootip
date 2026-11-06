import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { Public } from '../../config/auth/auth.js';
import { ProductListQueryDto } from './dto/product-list-query.dto.js';
import { ProductsService } from './product.service.js';

@Controller('products')
@Public()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() query: ProductListQueryDto) {
    return this.products.listPublic(query);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.findPublishedOne(id);
  }
}
