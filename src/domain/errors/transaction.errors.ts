import { DomainError } from "./domain.error";

export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, attemptedTransition: string) {
    super(
      `Cannot transition transaction from terminal or invalid state ${currentStatus} to ${attemptedTransition}`,
      "INVALID_TRANSACTION_STATE",
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used with a different payload`,
      "IDEMPOTENCY_PAYLOAD_CONFLICT",
    );
  }
}

export class InvalidInputContractError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_INPUT_CONTRACT");
  }
}
