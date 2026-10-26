import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Test, TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppModule } from "../src/app.module";
import { CreateWalletUseCase } from "../src/application/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../src/application/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../src/application/reconcile-wallet.use-case";
import { FailureCode } from "../src/domain/errors";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../src/domain/wager-transaction";
import { OutboxPublisherWorker } from "../src/infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "../src/infrastructure/messaging/pending-reference.worker";
import { SqsWagerConsumer } from "../src/infrastructure/messaging/sqs-wager.consumer";
import { SqsClientProvider } from "../src/infrastructure/messaging/sqs.client";
import {
  OutboxMessageEntity,
  WalletLedgerEntryEntity,
} from "../src/infrastructure/persistence/entities";

process.env.DISABLE_BACKGROUND_WORKERS = "true";
process.env.SILENT_LOGS = "true";

describe("Concorrência entre instâncias e recuperação", () => {
  let instances: TestingModule[] = [];
  let primaryOrm: MikroORM;
  let primaryEm: EntityManager;
  let createWallet: CreateWalletUseCase;
  let reconcileWallet: ReconcileWalletUseCase;

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const mod = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      if (i === 0) {
        primaryOrm = mod.get(MikroORM);
        await primaryOrm.getMigrator().up();
      }
      instances.push(mod);
    }
    primaryEm = instances[0]!.get(EntityManager);
    createWallet = instances[0]!.get(CreateWalletUseCase);
    reconcileWallet = instances[0]!.get(ReconcileWalletUseCase);
  });

  afterAll(async () => {
    for (const mod of instances) {
      await mod.close();
    }
  });

  it("registra um único débito quando a mesma aposta chega 50 vezes", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-50x-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const extId = `bet-50x-${crypto.randomUUID()}`;
    const idempKey = `provider-a:${extId}`;

    const promises = Array.from({ length: 50 }, (_, idx) => {
      const useCase = instances[idx % 3]!.get(ProcessWagerTransactionUseCase);
      return useCase.execute({
        idempotencyKey: idempKey,
        providerId: "provider-a",
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-50x",
        gameId: "slot-classic-v1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      });
    });

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance.amount).toBe("75.00");
    }

    const debitEntries = await primaryEm.count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT" as any,
    });
    expect(debitEntries).toBe(1);

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("75.00");
  });

  it("aprova apenas uma de duas apostas simultâneas de 80 BRL", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-race-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const bet1Id = `bet-80-a-${crypto.randomUUID()}`;
    const bet2Id = `bet-80-b-${crypto.randomUUID()}`;

    const [res1, res2] = await Promise.all([
      instances[0]!.get(ProcessWagerTransactionUseCase).execute({
        idempotencyKey: `provider-a:${bet1Id}`,
        providerId: "provider-a",
        externalTransactionId: bet1Id,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-race",
        gameId: "slot-classic-v1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "80.00", currency: "BRL" },
      }),
      instances[1]!.get(ProcessWagerTransactionUseCase).execute({
        idempotencyKey: `provider-a:${bet2Id}`,
        providerId: "provider-a",
        externalTransactionId: bet2Id,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-race",
        gameId: "slot-classic-v1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "80.00", currency: "BRL" },
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);

    const rejected =
      res1.status === WagerTransactionStatus.Rejected ? res1 : res2;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const debitEntries = await primaryEm.count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT" as any,
    });
    expect(debitEntries).toBe(1);

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("20.00");
  });

  it("processa operações simultâneas em carteiras diferentes", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createWallet.execute({
          playerId: `player-multi-${i}-${crypto.randomUUID()}`,
          initialBalance: { amount: "200.00", currency: "BRL" },
        }),
      ),
    );

    await Promise.all(
      wallets.flatMap((w, wIdx) =>
        Array.from({ length: 4 }, (_, txIdx) => {
          const inst = instances[(wIdx + txIdx) % 3]!.get(
            ProcessWagerTransactionUseCase,
          );
          const extId = `w-${wIdx}-tx-${txIdx}-${crypto.randomUUID()}`;
          return inst.execute({
            idempotencyKey: `prov:${extId}`,
            providerId: "prov",
            externalTransactionId: extId,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${txIdx}`,
            gameId: "g-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "25.00", currency: "BRL" },
          });
        }),
      ),
    );

    for (const w of wallets) {
      const rec = await reconcileWallet.execute(w.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("100.00");
    }
  });

  it("não duplica o razão quando a confirmação da SQS falha", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-crash-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const consumer1 = instances[0]!.get(SqsWagerConsumer);
    const consumer2 = instances[1]!.get(SqsWagerConsumer);
    const sqs1 = instances[0]!.get(SqsClientProvider);
    const sqs2 = instances[1]!.get(SqsClientProvider);

    while (true) {
      const prev = await sqs1.client.send(
        new ReceiveMessageCommand({
          QueueUrl: sqs1.wagerQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      if (!prev.Messages || prev.Messages.length === 0) break;
      for (const m of prev.Messages) {
        if (m.ReceiptHandle) {
          await sqs1.client.send(
            new DeleteMessageCommand({
              QueueUrl: sqs1.wagerQueueUrl,
              ReceiptHandle: m.ReceiptHandle,
            }),
          );
        }
      }
    }

    const extId = `tx-crash-${crypto.randomUUID()}`;
    await sqs1.client.send(
      new SendMessageCommand({
        QueueUrl: sqs1.wagerQueueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: extId,
        MessageBody: JSON.stringify({
          messageId: `msg-${extId}`,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-a",
            externalTransactionId: extId,
            idempotencyKey: `provider-a:${extId}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-crash",
            gameId: "slot-classic-v1",
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          },
        }),
      }),
    );

    const received = await sqs1.client.send(
      new ReceiveMessageCommand({
        QueueUrl: sqs1.wagerQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    expect(received.Messages?.length).toBe(1);
    const sqsMessage = received.Messages![0]!;

    const origSend1 = sqs1.client.send.bind(sqs1.client);
    sqs1.client.send = (async (cmd: unknown) => {
      if (cmd instanceof DeleteMessageCommand) {
        throw new Error("Connection terminated prior to SQS DeleteMessage ack");
      }
      return origSend1(cmd as any);
    }) as any;

    try {
      await expect(consumer1.handleSingleMessage(sqsMessage)).rejects.toThrow(
        "Connection terminated prior to SQS DeleteMessage ack",
      );

      await consumer2.handleSingleMessage(sqsMessage);
    } finally {
      sqs1.client.send = origSend1;
    }

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("70.00");
  });

  it("divide o lote da outbox entre workers sem duplicar eventos", async () => {
    const pub1 = instances[0]!.get(OutboxPublisherWorker);
    const pub2 = instances[1]!.get(OutboxPublisherWorker);
    const useCase = instances[0]!.get(ProcessWagerTransactionUseCase);

    while ((await pub1.publishPendingBatch(200)) > 0) {}

    const wallet = await createWallet.execute({
      playerId: `player-outbox-conc-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    for (let i = 0; i < 5; i++) {
      const extId = `outbox-bet-${i}-${crypto.randomUUID()}`;
      await useCase.execute({
        idempotencyKey: `provider-a:${extId}`,
        providerId: "provider-a",
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-outbox-${i}`,
        gameId: "slot-classic-v1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "10.00", currency: "BRL" },
      });
    }

    const pendingBefore = await primaryEm.count(OutboxMessageEntity, {
      publishedAt: null,
    });
    expect(pendingBefore).toBe(11);

    const [count1, count2] = await Promise.all([
      pub1.publishPendingBatch(7),
      pub2.publishPendingBatch(7),
    ]);

    expect(count1 + count2).toBe(11);

    const remainingUnpublished = await primaryEm.count(OutboxMessageEntity, {
      aggregateId: wallet.id,
      publishedAt: null,
    });
    expect(remainingUnpublished).toBe(0);
  });

  it("resolve um REFUND recebido antes da aposta após reiniciar", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-ooo-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const betExtId = `bet-ooo-${crypto.randomUUID()}`;
    const refundExtId = `ref-ooo-${crypto.randomUUID()}`;

    const useCase = instances[0]!.get(ProcessWagerTransactionUseCase);
    const pendingRefWorker = instances[1]!.get(PendingReferenceWorker);

    const refundFirst = await useCase.execute({
      idempotencyKey: `provider-a:${refundExtId}`,
      providerId: "provider-a",
      externalTransactionId: refundExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-ooo",
      gameId: "slot-classic-v1",
      kind: WagerTransactionKind.Refund,
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: betExtId,
    });
    expect(refundFirst.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refundFirst.balance.amount).toBe("100.00");

    const betSecond = await useCase.execute({
      idempotencyKey: `provider-a:${betExtId}`,
      providerId: "provider-a",
      externalTransactionId: betExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-ooo",
      gameId: "slot-classic-v1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "40.00", currency: "BRL" },
    });
    expect(betSecond.status).toBe(WagerTransactionStatus.Processed);
    expect(betSecond.balance.amount).toBe("60.00");

    await pendingRefWorker.processDuePendingReferences({
      ignoreSchedule: true,
    });

    const restartedMod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const restartedReconcile = restartedMod.get(ReconcileWalletUseCase);
    const rec = await restartedReconcile.execute(wallet.id);

    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("100.00");
    expect(rec.checkedEntries).toBe(3);

    await restartedMod.close();
  });
});
