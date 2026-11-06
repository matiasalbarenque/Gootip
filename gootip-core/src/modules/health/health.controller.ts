import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';

import { Public } from '../../config/auth/auth.js';

interface HealthResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  constructor() {}

  @Get()
  @Public()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
