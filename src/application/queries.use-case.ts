import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { EntityNotFoundError, InvalidInputContractError } from "../domain/errors";
import { assertNonEmptyString, assertValidUuid } from "../domain/validation";
import {
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from "../infrastructure/persistence/entities";

@Injectable()
export class QueriesUseCase {
  constructor(private readonly em: EntityManager) {}

  async getWallet(walletId: string) {
    const validWalletId = assertValidUuid(walletId, "walletId");
    const w = await this.em.findOne(WalletEntity, { id: validWalletId });
    if (!w) throw new EntityNotFoundError("Wallet", walletId);
    return {
      id: w.id,
      playerId: w.playerId,
      balance: { amount: w.balanceAmount, currency: w.currency },
      version: w.version,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  async getWalletLedger(walletId: string, cursor?: string, limit: number = 50) {
    const validWalletId = assertValidUuid(walletId, "walletId");
    const walletExists = await this.em.count(WalletEntity, { id: validWalletId });
    if (!walletExists) throw new EntityNotFoundError("Wallet", walletId);

    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    const where: Record<string, unknown> = { walletId: validWalletId };

    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        ) as { t: string; id: string };
        const cursorDate = new Date(decoded.t);
        if (isNaN(cursorDate.getTime()) || !decoded.id) {
          throw new Error("Malformed cursor");
        }
        where.$or = [
          { createdAt: { $gt: cursorDate } },
          { createdAt: cursorDate, id: { $gt: decoded.id } },
        ];
      } catch {
        throw new InvalidInputContractError("Invalid pagination cursor");
      }
    }

    const rows = await this.em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: "ASC", id: "ASC" },
      limit: safeLimit + 1,
    });

    const hasNextPage = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit);
    const lastItem = items[items.length - 1];

    const nextCursor =
      hasNextPage && lastItem
        ? Buffer.from(
            JSON.stringify({
              t: lastItem.createdAt.toISOString(),
              id: lastItem.id,
            }),
            "utf8",
          ).toString("base64url")
        : null;

    return {
      walletId,
      items: items.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: { amount: e.amount, currency: e.currency },
        balanceBefore: { amount: e.balanceBeforeAmount, currency: e.currency },
        balanceAfter: { amount: e.balanceAfterAmount, currency: e.currency },
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async getTransactionById(transactionId: string) {
    const validTxId = assertValidUuid(transactionId, "transactionId");
    const tx = await this.em.findOne(WagerTransactionEntity, { id: validTxId });
    if (!tx) throw new EntityNotFoundError("WagerTransaction", transactionId);
    return this.formatTransaction(tx);
  }

  async getTransactionByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ) {
    const validProviderId = assertNonEmptyString(providerId, "providerId");
    const validExtId = assertNonEmptyString(externalTransactionId, "externalTransactionId");
    const tx = await this.em.findOne(WagerTransactionEntity, {
      providerId: validProviderId,
      externalTransactionId: validExtId,
    });
    if (!tx) {
      throw new EntityNotFoundError(
        "WagerTransaction",
        `${providerId}:${externalTransactionId}`,
      );
    }
    return this.formatTransaction(tx);
  }

  private formatTransaction(tx: WagerTransactionEntity) {
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: { amount: tx.amount, currency: tx.currency },
      ...(tx.observedBalanceAmount && tx.observedBalanceCurrency
        ? {
            balance: {
              amount: tx.observedBalanceAmount,
              currency: tx.observedBalanceCurrency,
            },
          }
        : {}),
      ...(tx.referenceExternalTransactionId
        ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
        : {}),
      ...(tx.referenceTransactionId
        ? { referenceTransactionId: tx.referenceTransactionId }
        : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      createdAt: tx.createdAt.toISOString(),
      ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
    };
  }
}
