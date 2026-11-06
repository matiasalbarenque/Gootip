import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

@Injectable()
export class ErrorHandleService {
  private readonly logger = new Logger(ErrorHandleService.name);

  errorHandle(error: unknown): never {
    if (error instanceof HttpException) throw error;

    this.logger.error(error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException('Unexpected Error');
  }
}
