import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * Turns every thrown thing into a consistent JSON response.
 *
 * NFR-U-05: "Every error message shall state what went wrong and what the
 * user can do next." A raw Prisma error does neither — `P2002` means nothing
 * to a student, and the default message leaks column names. This filter maps
 * the database's vocabulary into something a client can act on, and logs the
 * detail server-side where it is useful.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.describe(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status} ${body.message}`);
    }

    response.status(status).json({
      ...body,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private describe(exception: unknown): {
    status: number;
    body: { code: string; message: string; details?: unknown };
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const status = exception.getStatus();

      // Throwing an object (as the verification guard does) carries a code
      // the client can branch on; throwing a string is the common case.
      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        return {
          status,
          body: {
            code: (obj.code as string) ?? this.codeForStatus(status),
            message: Array.isArray(obj.message)
              ? (obj.message as string[]).join('; ')
              : ((obj.message as string) ?? exception.message),
            details: obj.details ?? (Array.isArray(obj.message) ? obj.message : undefined),
          },
        };
      }

      return {
        status,
        body: { code: this.codeForStatus(status), message: String(res) },
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.describePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { code: 'INVALID_REQUEST', message: 'The request data was not valid.' },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. Please try again.',
      },
    };
  }

  private describePrisma(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    body: { code: string; message: string; details?: unknown };
  } {
    switch (e.code) {
      case 'P2002': {
        // Unique constraint. The target names the columns, which is safe to
        // surface for things like "this mobile number is already registered"
        // (FR-AUTH-04) but should not dump internal column names at a user.
        const target = (e.meta?.target as string[] | undefined) ?? [];
        const field = target[0] ?? 'value';
        const friendly: Record<string, string> = {
          mobile: 'That mobile number is already registered. Try logging in instead.',
          email: 'That email address is already registered. Try logging in instead.',
          reference: 'Duplicate order reference. Please retry.',
        };
        return {
          status: HttpStatus.CONFLICT,
          body: {
            code: 'ALREADY_EXISTS',
            message: friendly[field] ?? 'That value is already in use.',
          },
        };
      }

      case 'P2003':
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          body: {
            code: 'NOT_FOUND',
            message: 'The record you referred to does not exist.',
          },
        };

      case 'P2014':
        return {
          status: HttpStatus.CONFLICT,
          body: {
            code: 'DEPENDENT_RECORDS_EXIST',
            message:
              'This record is referenced elsewhere and cannot be removed. Financial and ' +
              'audit history is retained by design.',
          },
        };

      default: {
        // A check-constraint violation or an append-only trigger arrives here.
        // These mean the application tried to write something the database
        // forbids, which is a bug worth logging loudly rather than dressing up.
        const isCheckViolation =
          e.message.includes('violates check constraint') ||
          e.message.includes('is append-only');

        this.logger.error(`Unmapped Prisma error ${e.code}: ${e.message}`);

        return {
          status: isCheckViolation ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR,
          body: {
            code: isCheckViolation ? 'CONSTRAINT_VIOLATION' : 'DATABASE_ERROR',
            message: isCheckViolation
              ? 'That change would break a data rule and was rejected.'
              : 'A database error occurred. Please try again.',
          },
        };
      }
    }
  }

  private codeForStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE',
      429: 'RATE_LIMITED',
    };
    return map[status] ?? 'ERROR';
  }
}
