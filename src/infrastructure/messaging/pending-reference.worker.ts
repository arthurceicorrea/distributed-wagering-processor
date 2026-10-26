import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { FailureCode } from "../../domain/errors";
import { OutboxMessage } from "../../domain/outbox-message";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import {
  WagerTransactionEntity,
  WalletEntity,
} from "../persistence/entities";
import {
  InboxOutboxMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../persistence/mappers";

export const MAX_REFERENCE_RETRY_ATTEMPTS = 5;

@Injectable()
export class PendingReferenceWorker
  implements OnModuleInit, OnApplicationShutdown
{
  private timer?: ReturnType<typeof setInterval>;
  private isProcessing = false;

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit() {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") return;
    this.timer = setInterval(() => {
      void this.processDuePendingReferences();
    }, 500);
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    while (this.isProcessing) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async processDuePendingReferences(
    options?: { ignoreSchedule?: boolean; maxAttemptsOverride?: number },
  ): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;
    let handled = 0;
    const maxAttempts =
      options?.maxAttemptsOverride ?? MAX_REFERENCE_RETRY_ATTEMPTS;

    try {
      const discoveryFork = this.em.fork();
      const now = new Date();
      const discoveryQuery = options?.ignoreSchedule
        ? `
          SELECT id FROM wager_transactions
          WHERE status = 'PENDING_REFERENCE'
          ORDER BY created_at ASC
          LIMIT 20
        `
        : `
          SELECT id FROM wager_transactions
          WHERE status = 'PENDING_REFERENCE'
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
          ORDER BY created_at ASC
          LIMIT 20
        `;

      const candidates = await discoveryFork
        .getConnection()
        .execute<{ id: string }[]>(
          discoveryQuery,
          options?.ignoreSchedule ? [] : [now.toISOString()],
        );

      for (const candidate of candidates) {
        const itemFork = this.em.fork();
        const processedItem = await itemFork.transactional(async (txEm) => {
          const itemNow = new Date();
          const lockQuery = options?.ignoreSchedule
            ? `
              SELECT id FROM wager_transactions
              WHERE id = ?
                AND status = 'PENDING_REFERENCE'
              FOR UPDATE SKIP LOCKED
            `
            : `
              SELECT id FROM wager_transactions
              WHERE id = ?
                AND status = 'PENDING_REFERENCE'
                AND (next_retry_at IS NULL OR next_retry_at <= ?)
              FOR UPDATE SKIP LOCKED
            `;

          const lockedRows = await txEm
            .getConnection()
            .execute<{ id: string }[]>(
              lockQuery,
              options?.ignoreSchedule
                ? [candidate.id]
                : [candidate.id, itemNow.toISOString()],
            );

          if (lockedRows.length === 0) {
            return false;
          }

          const txEntity = await txEm.findOneOrFail(WagerTransactionEntity, {
            id: candidate.id,
          });
          const tx = WagerTransactionMapper.toDomain(txEntity);

          const walletEntity = await txEm.findOneOrFail(
            WalletEntity,
            { id: tx.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
          const wallet = WalletMapper.toDomain(walletEntity);

          const refEntity = await txEm.findOne(WagerTransactionEntity, {
            providerId: tx.providerId,
            externalTransactionId: tx.referenceExternalTransactionId!,
          });

          if (!refEntity) {
            this.rescheduleOrTimeout(
              txEm,
              tx,
              txEntity,
              wallet,
              maxAttempts,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          const refTx = WagerTransactionMapper.toDomain(refEntity);

          if (
            refTx.providerId !== tx.providerId ||
            refTx.playerId !== tx.playerId ||
            refTx.walletId !== tx.walletId ||
            refTx.money.currency !== tx.money.currency ||
            refTx.roundId !== tx.roundId
          ) {
            this.rejectPendingTx(
              txEm,
              tx,
              txEntity,
              wallet,
              FailureCode.InvalidReferenceContext,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          if (
            refTx.status === WagerTransactionStatus.Pending ||
            refTx.status === WagerTransactionStatus.PendingReference
          ) {
            this.rescheduleOrTimeout(
              txEm,
              tx,
              txEntity,
              wallet,
              maxAttempts,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          if (refTx.status !== WagerTransactionStatus.Processed) {
            this.rejectPendingTx(
              txEm,
              tx,
              txEntity,
              wallet,
              FailureCode.ReferenceNotProcessed,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          if (
            (tx.kind === WagerTransactionKind.Refund &&
              refTx.kind !== WagerTransactionKind.Bet) ||
            (tx.kind === WagerTransactionKind.Rollback &&
              refTx.kind !== WagerTransactionKind.Bet &&
              refTx.kind !== WagerTransactionKind.Win &&
              refTx.kind !== WagerTransactionKind.Refund)
          ) {
            this.rejectPendingTx(
              txEm,
              tx,
              txEntity,
              wallet,
              FailureCode.InvalidReferenceKind,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          if (!tx.money.equals(refTx.money)) {
            this.rejectPendingTx(
              txEm,
              tx,
              txEntity,
              wallet,
              FailureCode.ReferenceAmountMismatch,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          const duplicateReversal = await txEm.findOne(WagerTransactionEntity, {
            referenceTransactionId: refTx.id,
            kind: {
              $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
            },
            status: WagerTransactionStatus.Processed,
          });

          if (duplicateReversal) {
            this.rejectPendingTx(
              txEm,
              tx,
              txEntity,
              wallet,
              FailureCode.AlreadyReversed,
              itemNow,
            );
            await txEm.flush();
            return true;
          }

          const direction = tx.ledgerDirectionFor(refTx);
          if (direction === LedgerDirection.Debit) {
            if (!wallet.canDebit(tx.money)) {
              this.rejectPendingTx(
                txEm,
                tx,
                txEntity,
                wallet,
                FailureCode.ReversalInsufficientFunds,
                itemNow,
              );
              await txEm.flush();
              return true;
            }

            const entry = wallet.debit({
              transactionId: tx.id,
              entryId: crypto.randomUUID(),
              money: tx.money,
              at: itemNow,
              failureCodeOnInsufficient: FailureCode.ReversalInsufficientFunds,
            });
            WalletMapper.syncEntity(wallet, walletEntity);
            txEm.persist(WalletLedgerEntryMapper.toEntity(entry));
            txEm.persist(
              InboxOutboxMapper.toOutboxEntity(
                OutboxMessage.enqueue(
                  WalletBalanceChanged.from(wallet, entry, {
                    correlationId: tx.id,
                    causationId: tx.id,
                    occurredAt: itemNow,
                  }),
                ),
              ),
            );
          } else {
            const entry = wallet.credit({
              transactionId: tx.id,
              entryId: crypto.randomUUID(),
              money: tx.money,
              at: itemNow,
            });
            WalletMapper.syncEntity(wallet, walletEntity);
            txEm.persist(WalletLedgerEntryMapper.toEntity(entry));
            txEm.persist(
              InboxOutboxMapper.toOutboxEntity(
                OutboxMessage.enqueue(
                  WalletBalanceChanged.from(wallet, entry, {
                    correlationId: tx.id,
                    causationId: tx.id,
                    occurredAt: itemNow,
                  }),
                ),
              ),
            );
          }

          tx.markProcessed(refTx.id, itemNow, wallet.balance);
          WagerTransactionMapper.syncEntity(tx, txEntity);

          const processedEvent = WagerTransactionProcessed.from(
            tx,
            wallet.balance.toJSON(),
            { correlationId: tx.id, causationId: tx.id, occurredAt: itemNow },
          );
          txEm.persist(
            InboxOutboxMapper.toOutboxEntity(OutboxMessage.enqueue(processedEvent)),
          );
          this.metrics.incrementTransactionStatus(tx.status);
          await txEm.flush();
          return true;
        });

        if (processedItem) {
          handled += 1;
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return handled;
  }

  private rescheduleOrTimeout(
    txEm: EntityManager,
    tx: WagerTransaction,
    txEntity: WagerTransactionEntity,
    wallet: Wallet,
    maxAttempts: number,
    now: Date,
  ) {
    if (tx.retryAttempts >= maxAttempts) {
      this.rejectPendingTx(
        txEm,
        tx,
        txEntity,
        wallet,
        FailureCode.ReferenceNotFoundTimeout,
        now,
      );
    } else {
      tx.markPendingReference(now);
      WagerTransactionMapper.syncEntity(tx, txEntity);
      this.metrics.incrementRetries();
    }
  }

  private rejectPendingTx(
    txEm: EntityManager,
    tx: WagerTransaction,
    txEntity: WagerTransactionEntity,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
  ) {
    tx.reject(code, wallet.balance, now);
    WagerTransactionMapper.syncEntity(tx, txEntity);
    const rejectedEvent = WagerTransactionRejected.from(tx, code, {
      correlationId: tx.id,
      causationId: tx.id,
      occurredAt: now,
    });
    txEm.persist(
      InboxOutboxMapper.toOutboxEntity(OutboxMessage.enqueue(rejectedEvent)),
    );
    this.metrics.incrementTransactionStatus(tx.status);
  }
}
