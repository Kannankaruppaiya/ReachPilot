import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import pino from 'pino';

const logger = pino({ name: 'exception-filter' });

/** Turns every error into the frontend's `{ error: "message" }` shape with its status. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      if (typeof exResponse === 'string') {
        message = exResponse;
      } else if (typeof exResponse === 'object' && exResponse !== null) {
        // HttpException's `message` is the real reason; `error` is only the status name.
        const obj = exResponse as Record<string, unknown>;
        if (typeof obj['message'] === 'string') {
          message = obj['message'];
        } else if (Array.isArray(obj['message']) && obj['message'].length > 0) {
          message = String(obj['message'][0]);
        } else if (typeof obj['error'] === 'string') {
          message = obj['error'];
        }
      }
    } else if (exception instanceof Error) {
      logger.error({ err: exception }, 'Unhandled exception');
      message = 'An unexpected error occurred.';
    } else {
      logger.error({ exception }, 'Unknown exception type');
    }

    response.status(status).json({ error: message });
  }
}
