import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { gatewayClaimsMiddleware } from './config/auth/request-context.js';
import { createValidationPipe } from './validation.pipe.js';

export const API_PREFIX = 'api';

/**
 * Creates the Nest application shared by the local HTTP server and the Lambda
 * handler. The caller owns the lifecycle and never starts a TCP server here.
 */
export const createApp = async (): Promise<NestExpressApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix(API_PREFIX);
  app.use(gatewayClaimsMiddleware);
  app.useGlobalPipes(createValidationPipe());

  return app;
};
