import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { DuplicateWalletError } from "../domain/errors";
import { assertNonEmptyString } from "../domain/validation";
import { WalletBalanceChanged } from "../domain/events";
import { OutboxMessage } from "../domain/outbox-message";
import { Money, MoneyProps } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import {
  InboxOutboxMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../infrastructure/persistence/mappers";
import { computeCanonicalPayloadHash } from "./canonical-hash";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    const playerId = assertNonEmptyString(cmd?.playerId, "playerId");
    const initialMoney = Money.from(cmd?.initialBalance);
    const walletId = crypto.randomUUID();
    const now = new Date();
    const correlationId = cmd.correlationId ?? crypto.randomUUID();

    const { wallet, openingEntry, openingTransactionId } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: initialMoney,
      now,
    });

    try {
      await this.em.transactional(async (txEm) => {
        const walletEntity = WalletMapper.toEntity(wallet);
        txEm.persist(walletEntity);
        await txEm.flush();

        if (openingEntry && openingTransactionId) {
          const payloadHash = computeCanonicalPayloadHash({
            providerId: "SYSTEM",
            externalTransactionId: `opening:${wallet.id}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `opening:${wallet.id}`,
            gameId: "WALLET_OPENING",
            kind: WagerTransactionKind.Opening,
            money: initialMoney.toJSON(),
          });

          const openingTx = WagerTransaction.create({
            id: openingTransactionId,
            providerId: "SYSTEM",
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `SYSTEM:opening:${wallet.id}`,
            payloadHash,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: `opening:${wallet.id}`,
            gameId: "WALLET_OPENING",
            kind: WagerTransactionKind.Opening,
            money: initialMoney,
            createdAt: now,
            allowInternalOpening: true,
          });
          openingTx.markProcessed(undefined, now, wallet.balance);

          const txEntity = WagerTransactionMapper.toEntity(openingTx);
          const ledgerEntity = WalletLedgerEntryMapper.toEntity(openingEntry);
          const balanceEvent = WalletBalanceChanged.from(wallet, openingEntry, {
            correlationId,
            causationId: openingTx.id,
            occurredAt: now,
          });
          const outboxEntity = InboxOutboxMapper.toOutboxEntity(
            OutboxMessage.enqueue(balanceEvent),
          );

          txEm.persist(txEntity);
          await txEm.flush();
          txEm.persist([ledgerEntity, outboxEntity]);
        }

        await txEm.flush();
      });
    } catch (err: unknown) {
      const databaseError = getDatabaseError(err);
      if (
        databaseError?.code === "23505" ||
        databaseError?.message?.includes("uq_wallets_player_currency")
      ) {
        throw new DuplicateWalletError(playerId, initialMoney.currency);
      }
      throw err;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

function getDatabaseError(error: unknown): { code?: string; message?: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    message:
      typeof candidate.message === "string" ? candidate.message : undefined,
  };
}
