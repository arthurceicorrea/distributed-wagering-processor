import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import {
  CurrencyMismatchError,
  DomainError,
  DuplicateWalletError,
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidInputContractError,
  InvalidMoneyError,
} from "../../domain/errors";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidInputContractError
    ) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof DuplicateWalletError
    ) {
      res.status(HttpStatus.CONFLICT).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof EntityNotFoundError) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof CurrencyMismatchError) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: exception.code,
        failureCode: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof DomainError) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: exception.code,
        failureCode: exception.code,
        message: exception.message,
      });
      return;
    }

    const databaseError = getDatabaseError(exception);
    const pgCode = databaseError?.code;
    if (pgCode === "22P02" || pgCode === "23502" || pgCode === "23514") {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: "INVALID_INPUT_CONTRACT",
        message: databaseError?.message ?? "Malformed input parameter",
      });
      return;
    }

    const isTransientDatabaseError =
      typeof pgCode === "string" &&
      (pgCode.startsWith("08") || pgCode === "57P01");
    if (isTransientDatabaseError) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: "TRANSIENT_INFRASTRUCTURE_ERROR",
        message: "Temporary infrastructure unavailability, safe to retry",
      });
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error",
    });
  }
}

function getDatabaseError(
  error: unknown,
): { code?: string; message?: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    message:
      typeof candidate.message === "string" ? candidate.message : undefined,
  };
}
