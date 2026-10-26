import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  EntityNotFoundError,
  FailureCode,
  IdempotencyConflictError,
  InvalidInputContractError,
} from "../domain/errors";
import {
  assertNonEmptyString,
  assertValidExternalKind,
  assertValidUuid,
} from "../domain/validation";
import { InboxMessage } from "../domain/inbox-message";
import { OutboxMessage } from "../domain/outbox-message";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { Money, MoneyProps } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { MetricsService } from "../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../infrastructure/observability/structured-logger.service";
import {
  InboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
} from "../infrastructure/persistence/entities";
import {
  InboxOutboxMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../infrastructure/persistence/mappers";
import { computeCanonicalPayloadHash } from "./canonical-hash";

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: {
    messageId: string;
    consumerName: string;
  };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async execute(
    cmd: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const startTime = performance.now();
    const correlationId = cmd.correlationId ?? crypto.randomUUID();

    const idempotencyKey = assertNonEmptyString(
      cmd?.idempotencyKey,
      "Idempotency-Key",
    );
    const providerId = assertNonEmptyString(cmd?.providerId, "providerId");
    const externalTransactionId = assertNonEmptyString(
      cmd?.externalTransactionId,
      "externalTransactionId",
    );
    const playerId = assertNonEmptyString(cmd?.playerId, "playerId");
    const walletId = assertValidUuid(cmd?.walletId, "walletId");
    const roundId = assertNonEmptyString(cmd?.roundId, "roundId");
    const gameId = assertNonEmptyString(cmd?.gameId, "gameId");
    const kind = assertValidExternalKind(cmd?.kind);
    const referenceExternalTransactionId =
      cmd?.referenceExternalTransactionId !== undefined &&
      cmd?.referenceExternalTransactionId !== null
        ? assertNonEmptyString(
            cmd.referenceExternalTransactionId,
            "referenceExternalTransactionId",
          )
        : undefined;

    cmd = {
      ...cmd,
      idempotencyKey,
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      referenceExternalTransactionId,
    };

    const money = Money.from(cmd.money);
    const payloadHash = computeCanonicalPayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });

    try {
      const result = await this.em.transactional(async (txEm) => {
        const now = new Date();

        if (cmd.inboxContext) {
          const existingInbox = await txEm.findOne(InboxMessageEntity, {
            consumerName: cmd.inboxContext.consumerName,
            messageId: cmd.inboxContext.messageId,
          });

          if (existingInbox) {
            if (existingInbox.payloadHash !== payloadHash) {
              this.metrics.incrementDuplicates();
              throw new IdempotencyConflictError(cmd.idempotencyKey);
            }

            if (existingInbox.processedAt) {
              this.metrics.incrementDuplicates();
              const existingTx = await txEm.findOne(WagerTransactionEntity, {
                idempotencyKey: cmd.idempotencyKey,
              });
              if (existingTx) {
                const walletSnap = await txEm.findOneOrFail(WalletEntity, {
                  id: existingTx.walletId,
                });
                return this.buildReplayResponse(existingTx, walletSnap);
              }
            }

            existingInbox.processedAt = now;
          } else {
            const inboxMsg = InboxMessage.receive({
              messageId: cmd.inboxContext.messageId,
              consumerName: cmd.inboxContext.consumerName,
              payloadHash,
              receivedAt: now,
            });
            inboxMsg.markProcessed(now);
            txEm.persist(InboxOutboxMapper.toInboxEntity(inboxMsg));
          }
        }

        const preLockExistingTxEntity = await txEm.findOne(
          WagerTransactionEntity,
          {
            $or: [
              { idempotencyKey: cmd.idempotencyKey },
              {
                providerId: cmd.providerId,
                externalTransactionId: cmd.externalTransactionId,
              },
            ],
          },
        );

        if (preLockExistingTxEntity) {
          const preLockExistingTx = WagerTransactionMapper.toDomain(
            preLockExistingTxEntity,
          );
          if (
            preLockExistingTx.idempotencyKey !== cmd.idempotencyKey ||
            !preLockExistingTx.matchesPayload(payloadHash)
          ) {
            this.metrics.incrementDuplicates();
            throw new IdempotencyConflictError(cmd.idempotencyKey);
          }

          const originWalletEntity = await txEm.findOneOrFail(WalletEntity, {
            id: preLockExistingTxEntity.walletId,
          });
          this.metrics.incrementDuplicates();
          return this.buildReplayResponse(
            preLockExistingTxEntity,
            originWalletEntity,
          );
        }

        const walletEntity = await txEm.findOne(
          WalletEntity,
          { id: cmd.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!walletEntity) {
          throw new EntityNotFoundError("Wallet", cmd.walletId);
        }

        const wallet = WalletMapper.toDomain(walletEntity);

        const existingTxEntity = await txEm.findOne(WagerTransactionEntity, {
          $or: [
            { idempotencyKey: cmd.idempotencyKey },
            {
              providerId: cmd.providerId,
              externalTransactionId: cmd.externalTransactionId,
            },
          ],
        });

        if (existingTxEntity) {
          const existingTx =
            WagerTransactionMapper.toDomain(existingTxEntity);
          if (
            existingTx.idempotencyKey !== cmd.idempotencyKey ||
            !existingTx.matchesPayload(payloadHash)
          ) {
            this.metrics.incrementDuplicates();
            throw new IdempotencyConflictError(cmd.idempotencyKey);
          }

          this.metrics.incrementDuplicates();
          return this.buildReplayResponse(existingTxEntity, walletEntity);
        }

        const tx = WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind,
          money,
          referenceExternalTransactionId: cmd.referenceExternalTransactionId,
          createdAt: now,
        });

        if (wallet.playerId !== tx.playerId) {
          return await this.rejectTransaction(
            txEm,
            tx,
            wallet,
            FailureCode.WalletPlayerMismatch,
            correlationId,
            now,
          );
        }

        if (wallet.currency !== tx.money.currency) {
          return await this.rejectTransaction(
            txEm,
            tx,
            wallet,
            FailureCode.CurrencyMismatch,
            correlationId,
            now,
          );
        }

        let refTx: WagerTransaction | undefined;
        if (tx.referenceExternalTransactionId) {
          const refEntity = await txEm.findOne(WagerTransactionEntity, {
            providerId: tx.providerId,
            externalTransactionId: tx.referenceExternalTransactionId,
          });

          if (!refEntity && tx.requiresReference()) {
            tx.markPendingReference(now);
            const txEntity = WagerTransactionMapper.toEntity(tx);
            txEntity.observedBalanceAmount = wallet.balance.toJSON().amount;
            txEntity.observedBalanceCurrency = wallet.balance.currency;

            const pendingEvent = WagerTransactionPendingReference.from(tx, {
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            });
            const outboxEntity = InboxOutboxMapper.toOutboxEntity(
              OutboxMessage.enqueue(pendingEvent),
            );

            txEm.persist([txEntity, outboxEntity]);
            await txEm.flush();

            this.metrics.incrementTransactionStatus(tx.status);
            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          if (refEntity) {
            refTx = WagerTransactionMapper.toDomain(refEntity);
          }
        }

        if (
          tx.kind === WagerTransactionKind.Win &&
          tx.referenceExternalTransactionId
        ) {
          if (!refTx) {
            return await this.rejectTransaction(
              txEm,
              tx,
              wallet,
              FailureCode.ReferenceNotProcessed,
              correlationId,
              now,
            );
          }
          const winRefFailure = this.validateOptionalWinReference(tx, refTx);
          if (winRefFailure) {
            return await this.rejectTransaction(
              txEm,
              tx,
              wallet,
              winRefFailure,
              correlationId,
              now,
            );
          }
        }

        if (tx.requiresReference() && refTx) {
          const refValidationFailure = await this.validateReversalReference(
            txEm,
            tx,
            refTx,
          );

          if (refValidationFailure === "WAIT_FOR_PENDING_REF") {
            tx.markPendingReference(now);
            const txEntity = WagerTransactionMapper.toEntity(tx);
            txEntity.observedBalanceAmount = wallet.balance.toJSON().amount;
            txEntity.observedBalanceCurrency = wallet.balance.currency;

            const pendingEvent = WagerTransactionPendingReference.from(tx, {
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            });
            txEm.persist([
              txEntity,
              InboxOutboxMapper.toOutboxEntity(OutboxMessage.enqueue(pendingEvent)),
            ]);
            await txEm.flush();

            this.metrics.incrementTransactionStatus(tx.status);
            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          if (refValidationFailure) {
            return await this.rejectTransaction(
              txEm,
              tx,
              wallet,
              refValidationFailure,
              correlationId,
              now,
            );
          }
        }

        if (tx.affectsBalance()) {
          const direction = tx.ledgerDirectionFor(refTx);

          if (direction === LedgerDirection.Debit) {
            const insufficientCode =
              tx.kind === WagerTransactionKind.Rollback
                ? FailureCode.ReversalInsufficientFunds
                : FailureCode.InsufficientFunds;

            if (!wallet.canDebit(tx.money)) {
              return await this.rejectTransaction(
                txEm,
                tx,
                wallet,
                insufficientCode,
                correlationId,
                now,
              );
            }

            const entry = wallet.debit({
              transactionId: tx.id,
              entryId: crypto.randomUUID(),
              money: tx.money,
              at: now,
              failureCodeOnInsufficient: insufficientCode,
            });

            WalletMapper.syncEntity(wallet, walletEntity);
            txEm.persist(WalletLedgerEntryMapper.toEntity(entry));

            const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            });
            txEm.persist(
              InboxOutboxMapper.toOutboxEntity(OutboxMessage.enqueue(balanceEvent)),
            );
          } else {
            const entry = wallet.credit({
              transactionId: tx.id,
              entryId: crypto.randomUUID(),
              money: tx.money,
              at: now,
            });

            WalletMapper.syncEntity(wallet, walletEntity);
            txEm.persist(WalletLedgerEntryMapper.toEntity(entry));

            const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            });
            txEm.persist(
              InboxOutboxMapper.toOutboxEntity(OutboxMessage.enqueue(balanceEvent)),
            );
          }
        }

        tx.markProcessed(refTx?.id, now, wallet.balance);
        const txEntity = WagerTransactionMapper.toEntity(tx);
        const processedEvent = WagerTransactionProcessed.from(
          tx,
          wallet.balance.toJSON(),
          {
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          },
        );
        const outboxProcessed = InboxOutboxMapper.toOutboxEntity(
          OutboxMessage.enqueue(processedEvent),
        );

        txEm.persist([txEntity, outboxProcessed]);
        await txEm.flush();

        this.metrics.incrementTransactionStatus(tx.status);
        this.logger.info("Wager transaction processed", {
          correlationId,
          transactionId: tx.id,
          walletId: wallet.id,
          providerId: tx.providerId,
          status: tx.status,
          kind: tx.kind,
        });

        return {
          transactionId: tx.id,
          status: tx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      });

      this.metrics.observeProcessingLatency(performance.now() - startTime);
      return result;
    } catch (err: unknown) {
      const databaseError = getDatabaseError(err);
      if (databaseError?.code === "23505") {
        this.metrics.incrementLockConflicts();
        const existingTxEntity = await this.em.findOne(WagerTransactionEntity, {
          $or: [
            { idempotencyKey: cmd.idempotencyKey },
            {
              providerId: cmd.providerId,
              externalTransactionId: cmd.externalTransactionId,
            },
          ],
        });
        if (existingTxEntity) {
          const existingTx =
            WagerTransactionMapper.toDomain(existingTxEntity);
          if (
            existingTx.idempotencyKey !== cmd.idempotencyKey ||
            !existingTx.matchesPayload(payloadHash)
          ) {
            throw new IdempotencyConflictError(cmd.idempotencyKey);
          }
          const walletEntity = await this.em.findOneOrFail(WalletEntity, {
            id: existingTxEntity.walletId,
          });
          this.metrics.incrementDuplicates();
          return this.buildReplayResponse(existingTxEntity, walletEntity);
        }
      }
      throw err;
    }
  }

  private validateOptionalWinReference(
    tx: WagerTransaction,
    refTx: WagerTransaction,
  ): FailureCode | null {
    if (
      refTx.providerId !== tx.providerId ||
      refTx.playerId !== tx.playerId ||
      refTx.walletId !== tx.walletId ||
      refTx.money.currency !== tx.money.currency ||
      refTx.roundId !== tx.roundId
    ) {
      return FailureCode.InvalidReferenceContext;
    }

    if (refTx.kind !== WagerTransactionKind.Bet) {
      return FailureCode.InvalidReferenceKind;
    }

    if (refTx.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    return null;
  }

  private async validateReversalReference(
    txEm: EntityManager,
    tx: WagerTransaction,
    refTx: WagerTransaction,
  ): Promise<FailureCode | "WAIT_FOR_PENDING_REF" | null> {
    if (
      refTx.providerId !== tx.providerId ||
      refTx.playerId !== tx.playerId ||
      refTx.walletId !== tx.walletId ||
      refTx.money.currency !== tx.money.currency ||
      refTx.roundId !== tx.roundId
    ) {
      return FailureCode.InvalidReferenceContext;
    }

    if (
      refTx.status === WagerTransactionStatus.Pending ||
      refTx.status === WagerTransactionStatus.PendingReference
    ) {
      return "WAIT_FOR_PENDING_REF";
    }

    if (refTx.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    if (tx.kind === WagerTransactionKind.Refund) {
      if (refTx.kind !== WagerTransactionKind.Bet) {
        return FailureCode.InvalidReferenceKind;
      }
    } else if (tx.kind === WagerTransactionKind.Rollback) {
      if (
        refTx.kind !== WagerTransactionKind.Bet &&
        refTx.kind !== WagerTransactionKind.Win &&
        refTx.kind !== WagerTransactionKind.Refund
      ) {
        return FailureCode.InvalidReferenceKind;
      }
    }

    if (!tx.money.equals(refTx.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }

    const existingReversal = await txEm.findOne(WagerTransactionEntity, {
      referenceTransactionId: refTx.id,
      kind: {
        $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
      },
      status: WagerTransactionStatus.Processed,
    });

    if (existingReversal) {
      return FailureCode.AlreadyReversed;
    }

    return null;
  }

  private async rejectTransaction(
    txEm: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    correlationId: string,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    tx.reject(failureCode, wallet.balance, now);
    const txEntity = WagerTransactionMapper.toEntity(tx);
    const rejectedEvent = WagerTransactionRejected.from(tx, failureCode, {
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });
    const outboxRejected = InboxOutboxMapper.toOutboxEntity(
      OutboxMessage.enqueue(rejectedEvent),
    );

    txEm.persist([txEntity, outboxRejected]);
    await txEm.flush();

    this.metrics.incrementTransactionStatus(tx.status);
    this.logger.warn("Wager transaction rejected by business rule", {
      correlationId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: tx.providerId,
      failureCode,
    });

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      failureCode,
    };
  }

  private buildReplayResponse(
    txEntity: WagerTransactionEntity,
    walletEntity: WalletEntity,
  ): ProcessWagerTransactionResult {
    const balance: MoneyProps =
      txEntity.observedBalanceAmount && txEntity.observedBalanceCurrency
        ? {
            amount: txEntity.observedBalanceAmount,
            currency: txEntity.observedBalanceCurrency,
          }
        : {
            amount: walletEntity.balanceAmount,
            currency: walletEntity.currency,
          };

    return {
      transactionId: txEntity.id,
      status: txEntity.status,
      balance,
      idempotentReplay: true,
      ...(txEntity.failureCode ? { failureCode: txEntity.failureCode } : {}),
    };
  }
}

function getDatabaseError(error: unknown): { code?: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? { code: candidate.code } : null;
}
