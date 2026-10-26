import { MikroORM } from "@mikro-orm/core";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { CreateWalletUseCase } from "../src/application/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../src/application/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../src/application/reconcile-wallet.use-case";
import { WagerTransactionKind } from "../src/domain/wager-transaction";
import { OutboxPublisherWorker } from "../src/infrastructure/messaging/outbox-publisher.worker";
import { MetricsService } from "../src/infrastructure/observability/metrics.service";

process.env.DISABLE_BACKGROUND_WORKERS = "true";
process.env.SILENT_LOGS = "true";

async function runLoadTest() {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const orm = mod.get(MikroORM);
  await orm.getMigrator().up();

  const createWallet = mod.get(CreateWalletUseCase);
  const processWager = mod.get(ProcessWagerTransactionUseCase);
  const reconcile = mod.get(ReconcileWalletUseCase);
  const outboxWorker = mod.get(OutboxPublisherWorker);
  const metrics = mod.get(MetricsService);

  const walletCount = 20;
  const opsPerWallet = 25;
  const totalOps = walletCount * opsPerWallet;

  console.log(`Creating ${walletCount} wallets...`);
  const wallets = await Promise.all(
    Array.from({ length: walletCount }, (_, i) =>
      createWallet.execute({
        playerId: `load-player-${i}-${crypto.randomUUID()}`,
        initialBalance: { amount: "1000.00", currency: "BRL" },
      }),
    ),
  );

  while ((await outboxWorker.publishPendingBatch(100)) > 0) {}

  console.log(`Executing ${totalOps} concurrent wager transactions...`);
  const start = performance.now();

  const outboxTimer = setInterval(() => {
    void outboxWorker.publishPendingBatch(100);
  }, 100);

  const batchConcurrencyPerWallet = 5;
  try {
    await Promise.all(
      wallets.map(async (w) => {
        for (let baseIdx = 0; baseIdx < opsPerWallet; baseIdx += batchConcurrencyPerWallet) {
          const batch = Array.from({ length: batchConcurrencyPerWallet }, (_, offset) => {
            const txIdx = baseIdx + offset;
            const extId = `load-${w.id}-${txIdx}`;
            return processWager.execute({
              idempotencyKey: `load-prov:${extId}`,
              providerId: "load-prov",
              externalTransactionId: extId,
              playerId: w.playerId,
              walletId: w.id,
              roundId: `round-${txIdx}`,
              gameId: "slot-classic-v1",
              kind: txIdx % 2 === 0 ? WagerTransactionKind.Bet : WagerTransactionKind.Win,
              money: { amount: "10.00", currency: "BRL" },
            });
          });
          await Promise.all(batch);
        }
      }),
    );
  } finally {
    clearInterval(outboxTimer);
  }

  const durationSec = (performance.now() - start) / 1000;

  while ((await outboxWorker.publishPendingBatch(200)) > 0) {}

  for (const w of wallets) {
    const rec = await reconcile.execute(w.id);
    if (!rec.consistent) {
      throw new Error(`Inconsistency detected in wallet ${w.id}`);
    }
  }

  console.log("=== LOAD TEST REPORT ===");
  console.log(
    JSON.stringify(
      {
        totalOperations: totalOps,
        durationSeconds: Number(durationSec.toFixed(2)),
        throughputOpsPerSec: Number((totalOps / durationSec).toFixed(2)),
        allWalletsConsistent: true,
        metrics: metrics.snapshot(),
      },
      null,
      2,
    ),
  );

  await mod.close();
}

runLoadTest();
