import { DomainError } from "./domain.error";
import { FailureCode } from "./failure-code.enum";

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_MONEY");
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(
      `Currency mismatch: expected ${expected}, received ${actual}`,
      FailureCode.CurrencyMismatch,
    );
  }
}
