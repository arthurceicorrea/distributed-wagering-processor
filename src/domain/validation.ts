import { InvalidInputContractError } from "./errors";
import { WagerTransactionKind } from "./wager-transaction";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidInputContractError(
      `Field '${fieldName}' must be a non-empty string`,
    );
  }
  return value.trim();
}

export function assertValidUuid(value: unknown, fieldName: string): string {
  const trimmed = assertNonEmptyString(value, fieldName);
  if (!UUID_REGEX.test(trimmed)) {
    throw new InvalidInputContractError(
      `Field '${fieldName}' must be a valid UUID`,
    );
  }
  return trimmed;
}

export function assertValidExternalKind(
  value: unknown,
): WagerTransactionKind {
  const kind = assertNonEmptyString(value, "kind");
  if (!ALLOWED_EXTERNAL_KINDS.has(kind)) {
    throw new InvalidInputContractError(
      `Invalid transaction kind '${kind}'. Allowed values: BET, WIN, LOSS, REFUND, ROLLBACK`,
    );
  }
  return kind as WagerTransactionKind;
}
