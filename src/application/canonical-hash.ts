import { createHash } from "crypto";
import { MoneyProps } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";

export interface CanonicalWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function computeCanonicalPayloadHash(payload: CanonicalWagerPayload): string {
  const businessSubset: CanonicalWagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    ...(payload.referenceExternalTransactionId
      ? { referenceExternalTransactionId: payload.referenceExternalTransactionId }
      : {}),
  };

  const canonicalJson = JSON.stringify(canonicalizeValue(businessSubset));
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
