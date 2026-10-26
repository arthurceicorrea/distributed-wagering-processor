import { Money } from "../../../domain/money";
import { WagerTransaction } from "../../../domain/wager-transaction";
import { WagerTransactionEntity } from "../entities/wager-transaction.entity";

export class WagerTransactionMapper {
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      createdAt: entity.createdAt,
      status: entity.status,
      referenceTransactionId: entity.referenceTransactionId,
      failureCode: entity.failureCode,
      processedAt: entity.processedAt,
      observedBalance:
        entity.observedBalanceAmount && entity.observedBalanceCurrency
          ? Money.from({
              amount: entity.observedBalanceAmount,
              currency: entity.observedBalanceCurrency,
            })
          : undefined,
      retryAttempts: entity.retryAttempts,
      nextRetryAt: entity.nextRetryAt,
    });
  }

  static toEntity(domain: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    const moneyProps = domain.money.toJSON();
    entity.id = domain.id;
    entity.providerId = domain.providerId;
    entity.externalTransactionId = domain.externalTransactionId;
    entity.idempotencyKey = domain.idempotencyKey;
    entity.payloadHash = domain.payloadHash;
    entity.walletId = domain.walletId;
    entity.playerId = domain.playerId;
    entity.roundId = domain.roundId;
    entity.gameId = domain.gameId;
    entity.kind = domain.kind;
    entity.amount = moneyProps.amount;
    entity.currency = moneyProps.currency;
    entity.referenceExternalTransactionId = domain.referenceExternalTransactionId;
    entity.referenceTransactionId = domain.referenceTransactionId;
    entity.status = domain.status;
    entity.failureCode = domain.failureCode;
    if (domain.observedBalance) {
      const obs = domain.observedBalance.toJSON();
      entity.observedBalanceAmount = obs.amount;
      entity.observedBalanceCurrency = obs.currency;
    }
    entity.retryAttempts = domain.retryAttempts;
    entity.nextRetryAt = domain.nextRetryAt;
    entity.createdAt = domain.createdAt;
    entity.processedAt = domain.processedAt;
    return entity;
  }

  static syncEntity(
    domain: WagerTransaction,
    entity: WagerTransactionEntity,
  ): void {
    entity.status = domain.status;
    entity.referenceTransactionId = domain.referenceTransactionId;
    entity.failureCode = domain.failureCode;
    entity.processedAt = domain.processedAt;
    entity.retryAttempts = domain.retryAttempts;
    entity.nextRetryAt = domain.nextRetryAt;
    if (domain.observedBalance) {
      const obs = domain.observedBalance.toJSON();
      entity.observedBalanceAmount = obs.amount;
      entity.observedBalanceCurrency = obs.currency;
    }
  }
}
