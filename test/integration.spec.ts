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
import { FailureCode, IdempotencyConflictError } from "../src/domain/errors";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../src/domain/wager-transaction";
import { OutboxPublisherWorker } from "../src/infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "../src/infrastructure/messaging/pending-reference.worker";
import { SqsWagerConsumer } from "../src/infrastructure/messaging/sqs-wager.consumer";
import { SqsClientProvider } from "../src/infrastructure/messaging/sqs.client";
import { OutboxMessageEntity } from "../src/infrastructure/persistence/entities";

process.env.DISABLE_BACKGROUND_WORKERS = "true";
process.env.SILENT_LOGS = "true";

describe("Integração com PostgreSQL e LocalStack SQS", () => {
  let moduleRef: TestingModule;
  let orm: MikroORM;
  let em: EntityManager;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;
  let sqsConsumer: SqsWagerConsumer;
  let outboxWorker: OutboxPublisherWorker;
  let pendingRefWorker: PendingReferenceWorker;
  let sqsProvider: SqsClientProvider;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    orm = moduleRef.get(MikroORM);
    await orm.getMigrator().up();
    em = moduleRef.get(EntityManager);
    createWallet = moduleRef.get(CreateWalletUseCase);
    processWager = moduleRef.get(ProcessWagerTransactionUseCase);
    reconcileWallet = moduleRef.get(ReconcileWalletUseCase);
    sqsConsumer = moduleRef.get(SqsWagerConsumer);
    outboxWorker = moduleRef.get(OutboxPublisherWorker);
    pendingRefWorker = moduleRef.get(PendingReferenceWorker);
    sqsProvider = moduleRef.get(SqsClientProvider);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("bloqueia alterações nos lançamentos do razão", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-trig-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await expect(
      em
        .getConnection()
        .execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [
          wallet.id,
        ]),
    ).rejects.toThrow();

    await expect(
      em
        .getConnection()
        .execute(
          `UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = ?`,
          [wallet.id],
        ),
    ).rejects.toThrow();
  });

  it("recusa um estorno que deixaria o saldo negativo", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-rev-${crypto.randomUUID()}`,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });

    const winId = `win-${crypto.randomUUID()}`;
    await processWager.execute({
      idempotencyKey: `prov:${winId}`,
      providerId: "prov",
      externalTransactionId: winId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-10",
      gameId: "g-1",
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
    });

    const betId = `bet-${crypto.randomUUID()}`;
    await processWager.execute({
      idempotencyKey: `prov:${betId}`,
      providerId: "prov",
      externalTransactionId: betId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-11",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "40.00", currency: "BRL" },
    });

    const rbId = `rb-${crypto.randomUUID()}`;
    const rbResult = await processWager.execute({
      idempotencyKey: `prov:${rbId}`,
      providerId: "prov",
      externalTransactionId: rbId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-10",
      gameId: "g-1",
      kind: WagerTransactionKind.Rollback,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: winId,
    });

    expect(rbResult.status).toBe(WagerTransactionStatus.Rejected);
    expect(rbResult.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rbResult.balance.amount).toBe("20.00");

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  it("recusa uma chave de idempotência reutilizada com outros dados", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-idemp-409-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const extId = `bet-idemp-${crypto.randomUUID()}`;
    const idempKey = `prov:${extId}`;

    await processWager.execute({
      idempotencyKey: idempKey,
      providerId: "prov",
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-idemp",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
    });

    await expect(
      processWager.execute({
        idempotencyKey: idempKey,
        providerId: "prov",
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: crypto.randomUUID(),
        roundId: "r-idemp",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "20.00", currency: "BRL" },
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("recusa uma mensagem da inbox processada com outro payload", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-inbox-409-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const extId = `bet-inbox-${crypto.randomUUID()}`;
    const idempKey = `prov:${extId}`;
    const msgId = `msg-inbox-${crypto.randomUUID()}`;

    await processWager.execute({
      idempotencyKey: idempKey,
      providerId: "prov",
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-inbox",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
      inboxContext: {
        messageId: msgId,
        consumerName: "sqs-wager-transactions-consumer",
      },
    });

    await expect(
      processWager.execute({
        idempotencyKey: idempKey,
        providerId: "prov",
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "r-inbox",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "50.00", currency: "BRL" },
        inboxContext: {
          messageId: msgId,
          consumerName: "sqs-wager-transactions-consumer",
        },
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("resolve a cadeia de estornos quando a aposta chega por último", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-chain-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const betExtId = `chain-bet-${crypto.randomUUID()}`;
    const refundExtId = `chain-ref-${crypto.randomUUID()}`;
    const rollbackExtId = `chain-rb-${crypto.randomUUID()}`;

    const refRes = await processWager.execute({
      idempotencyKey: `prov:${refundExtId}`,
      providerId: "prov",
      externalTransactionId: refundExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-chain",
      gameId: "g-1",
      kind: WagerTransactionKind.Refund,
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: betExtId,
    });
    expect(refRes.status).toBe(WagerTransactionStatus.PendingReference);

    const rbRes = await processWager.execute({
      idempotencyKey: `prov:${rollbackExtId}`,
      providerId: "prov",
      externalTransactionId: rollbackExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-chain",
      gameId: "g-1",
      kind: WagerTransactionKind.Rollback,
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: refundExtId,
    });
    expect(rbRes.status).toBe(WagerTransactionStatus.PendingReference);

    await pendingRefWorker.processDuePendingReferences({ ignoreSchedule: true });

    const betRes = await processWager.execute({
      idempotencyKey: `prov:${betExtId}`,
      providerId: "prov",
      externalTransactionId: betExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r-chain",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);
    expect(betRes.balance.amount).toBe("70.00");

    await pendingRefWorker.processDuePendingReferences({ ignoreSchedule: true });
    await pendingRefWorker.processDuePendingReferences({ ignoreSchedule: true });

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("70.00");
  });

  it("valida a referência opcional de WIN", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-winref-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const betExtId = `bet-winref-${crypto.randomUUID()}`;
    await processWager.execute({
      idempotencyKey: `prov:${betExtId}`,
      providerId: "prov",
      externalTransactionId: betExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-win-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
    });

    const missingWinId = `win-missing-${crypto.randomUUID()}`;
    const missingWin = await processWager.execute({
      idempotencyKey: `prov:${missingWinId}`,
      providerId: "prov",
      externalTransactionId: missingWinId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-win-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: `non-existent-bet-${crypto.randomUUID()}`,
    });
    expect(missingWin.status).toBe(WagerTransactionStatus.Rejected);
    expect(missingWin.failureCode).toBe(FailureCode.ReferenceNotProcessed);

    const badWinId = `win-bad-${crypto.randomUUID()}`;
    const badWin = await processWager.execute({
      idempotencyKey: `prov:${badWinId}`,
      providerId: "prov",
      externalTransactionId: badWinId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-win-DIFFERENT",
      gameId: "g-1",
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: betExtId,
    });
    expect(badWin.status).toBe(WagerTransactionStatus.Rejected);
    expect(badWin.failureCode).toBe(FailureCode.InvalidReferenceContext);

    const okWinId = `win-ok-${crypto.randomUUID()}`;
    const okWin = await processWager.execute({
      idempotencyKey: `prov:${okWinId}`,
      providerId: "prov",
      externalTransactionId: okWinId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-win-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: betExtId,
    });
    expect(okWin.status).toBe(WagerTransactionStatus.Processed);
    expect(okWin.balance.amount).toBe("130.00");
  });

  it("envia mensagens inválidas da SQS para a DLQ", async () => {
    // Drain any prior messages on wagerQueueUrl to isolate the test
    while (true) {
      const prev = await sqsProvider.client.send(
        new ReceiveMessageCommand({
          QueueUrl: sqsProvider.wagerQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      if (!prev.Messages || prev.Messages.length === 0) break;
      for (const m of prev.Messages) {
        if (m.ReceiptHandle) {
          await sqsProvider.client.send(
            new DeleteMessageCommand({
              QueueUrl: sqsProvider.wagerQueueUrl,
              ReceiptHandle: m.ReceiptHandle,
            }),
          );
        }
      }
    }

    await sqsProvider.client.send(
      new SendMessageCommand({
        QueueUrl: sqsProvider.wagerQueueUrl,
        MessageBody: "{ invalid_json",
        MessageGroupId: `dlq-test-${crypto.randomUUID()}`,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );

    const received = await sqsProvider.client.send(
      new ReceiveMessageCommand({
        QueueUrl: sqsProvider.wagerQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    expect(received.Messages?.length).toBe(1);

    await sqsConsumer.handleSingleMessage(received.Messages![0]!);

    const dlqCheck = await sqsProvider.client.send(
      new ReceiveMessageCommand({
        QueueUrl: sqsProvider.wagerDlqUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(dlqCheck.Messages?.length).toBeGreaterThanOrEqual(1);
  });

  it("publica os eventos pendentes da outbox", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-outbox-${crypto.randomUUID()}`,
      initialBalance: { amount: "200.00", currency: "BRL" },
    });

    await outboxWorker.publishPendingBatch(50);

    const unpublished = await em.count(OutboxMessageEntity, {
      aggregateId: wallet.id,
      publishedAt: null,
    });
    expect(unpublished).toBe(0);

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  it("encerra uma referência pendente depois do limite de tentativas", async () => {
    const wallet = await createWallet.execute({
      playerId: `player-timeout-${crypto.randomUUID()}`,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const orphanRefundId = `orphan-ref-${crypto.randomUUID()}`;
    const missingBetExtId = `never-arrives-${crypto.randomUUID()}`;
    const initialRes = await processWager.execute({
      idempotencyKey: `prov:${orphanRefundId}`,
      providerId: "prov",
      externalTransactionId: orphanRefundId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-timeout",
      gameId: "g-1",
      kind: WagerTransactionKind.Refund,
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: missingBetExtId,
    });
    expect(initialRes.status).toBe(WagerTransactionStatus.PendingReference);

    for (let i = 0; i < 3; i++) {
      await pendingRefWorker.processDuePendingReferences({
        ignoreSchedule: true,
        maxAttemptsOverride: 2,
      });
    }

    const replayRes = await processWager.execute({
      idempotencyKey: `prov:${orphanRefundId}`,
      providerId: "prov",
      externalTransactionId: orphanRefundId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-timeout",
      gameId: "g-1",
      kind: WagerTransactionKind.Refund,
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: missingBetExtId,
    });
    expect(replayRes.idempotentReplay).toBe(true);
    expect(replayRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(replayRes.failureCode).toBe(FailureCode.ReferenceNotFoundTimeout);

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("100.00");
  });
});
