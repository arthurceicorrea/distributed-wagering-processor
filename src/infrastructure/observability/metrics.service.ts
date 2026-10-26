import { Injectable } from "@nestjs/common";

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus = new Map<string, number>();
  private duplicatesDetected = 0;
  private retriesCount = 0;
  private dlqMessagesCount = 0;
  private lockConflictsCount = 0;
  private reconciliationDivergences = 0;
  private outboxLagMs = 0;
  private readonly latenciesMs: number[] = [];

  incrementTransactionStatus(status: string) {
    this.transactionsByStatus.set(
      status,
      (this.transactionsByStatus.get(status) ?? 0) + 1,
    );
  }

  incrementDuplicates() {
    this.duplicatesDetected += 1;
  }

  incrementRetries() {
    this.retriesCount += 1;
  }

  incrementDlqMessages() {
    this.dlqMessagesCount += 1;
  }

  incrementLockConflicts() {
    this.lockConflictsCount += 1;
  }

  incrementReconciliationDivergence() {
    this.reconciliationDivergences += 1;
  }

  setOutboxLagMs(lagMs: number) {
    this.outboxLagMs = lagMs;
  }

  observeProcessingLatency(ms: number) {
    this.latenciesMs.push(ms);
    if (this.latenciesMs.length > 5000) {
      this.latenciesMs.shift();
    }
  }

  snapshot() {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted.length === 0
        ? 0
        : Number(sorted[Math.floor((p / 100) * (sorted.length - 1))]!.toFixed(2));

    return {
      transactionsByStatus: Object.fromEntries(this.transactionsByStatus),
      duplicatesDetected: this.duplicatesDetected,
      retriesCount: this.retriesCount,
      dlqMessagesCount: this.dlqMessagesCount,
      lockConflictsCount: this.lockConflictsCount,
      reconciliationDivergences: this.reconciliationDivergences,
      outboxLagMs: this.outboxLagMs,
      latencyMs: {
        count: sorted.length,
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99),
      },
    };
  }
}
