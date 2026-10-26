import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import Decimal from "decimal.js";
import { EntityNotFoundError } from "../domain/errors";
import { assertValidUuid } from "../domain/validation";
import { MoneyProps } from "../domain/money";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { MetricsService } from "../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../infrastructure/observability/structured-logger.service";
import {
  WalletEntity,
  WalletLedgerEntryEntity,
} from "../infrastructure/persistence/entities";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  async execute(walletId: string, correlationId?: string): Promise<ReconciliationResult> {
    const validWalletId = assertValidUuid(walletId, "walletId");
    this.em.clear();
    const walletEntity = await this.em.findOne(WalletEntity, { id: validWalletId });
    if (!walletEntity) {
      throw new EntityNotFoundError("Wallet", walletId);
    }

    const entries = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId },
      { orderBy: { createdAt: "ASC", id: "ASC" } },
    );

    let calculated = new Decimal("0.00");
    for (const entry of entries) {
      const amt = new Decimal(entry.amount);
      if (entry.direction === LedgerDirection.Credit) {
        calculated = calculated.plus(amt);
      } else {
        calculated = calculated.minus(amt);
      }
    }

    const storedDecimal = new Decimal(walletEntity.balanceAmount);
    const diffDecimal = storedDecimal.minus(calculated);
    const consistent = diffDecimal.isZero();

    if (!consistent) {
      this.metrics.incrementReconciliationDivergence();
      this.logger.error("Wallet reconciliation divergence detected", {
        correlationId: correlationId ?? crypto.randomUUID(),
        walletId,
        consistent: false,
        checkedEntries: entries.length,
      });
    }

    return {
      walletId,
      storedBalance: {
        amount: storedDecimal.toFixed(2),
        currency: walletEntity.currency,
      },
      calculatedBalance: {
        amount: calculated.toFixed(2),
        currency: walletEntity.currency,
      },
      difference: {
        amount: diffDecimal.toFixed(2),
        currency: walletEntity.currency,
      },
      consistent,
      checkedEntries: entries.length,
    };
  }
}
