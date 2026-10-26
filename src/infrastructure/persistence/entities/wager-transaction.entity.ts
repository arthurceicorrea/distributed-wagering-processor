import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { FailureCode } from "../../../domain/errors";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction";

@Entity({ tableName: "wager_transactions" })
@Unique({ properties: ["idempotencyKey"], name: "uq_wager_tx_idempotency_key" })
@Unique({
  properties: ["providerId", "externalTransactionId"],
  name: "uq_wager_tx_provider_ext_id",
})
@Index({ properties: ["walletId", "createdAt"], name: "idx_wager_tx_wallet_created" })
@Index({
  properties: ["status", "nextRetryAt"],
  name: "idx_wager_tx_pending_ref_retry",
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "provider_id", type: "varchar", length: 128 })
  providerId!: string;

  @Property({ fieldName: "external_transaction_id", type: "varchar", length: 128 })
  externalTransactionId!: string;

  @Property({ fieldName: "idempotency_key", type: "varchar", length: 256 })
  idempotencyKey!: string;

  @Property({ fieldName: "payload_hash", type: "varchar", length: 64 })
  payloadHash!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "player_id", type: "varchar", length: 128 })
  playerId!: string;

  @Property({ fieldName: "round_id", type: "varchar", length: 128 })
  roundId!: string;

  @Property({ fieldName: "game_id", type: "varchar", length: 128 })
  gameId!: string;

  @Property({ type: "varchar", length: 32 })
  kind!: WagerTransactionKind;

  @Property({ columnType: "numeric(19,2)", type: "string" })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({
    fieldName: "reference_external_transaction_id",
    type: "varchar",
    length: 128,
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({
    fieldName: "reference_transaction_id",
    type: "uuid",
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({ type: "varchar", length: 32 })
  status!: WagerTransactionStatus;

  @Property({
    fieldName: "failure_code",
    type: "varchar",
    length: 64,
    nullable: true,
  })
  failureCode?: FailureCode;

  @Property({
    fieldName: "observed_balance_amount",
    columnType: "numeric(19,2)",
    type: "string",
    nullable: true,
  })
  observedBalanceAmount?: string;

  @Property({
    fieldName: "observed_balance_currency",
    type: "varchar",
    length: 3,
    nullable: true,
  })
  observedBalanceCurrency?: string;

  @Property({ fieldName: "retry_attempts", type: "integer", default: 0 })
  retryAttempts: number = 0;

  @Property({ fieldName: "next_retry_at", type: "timestamptz", nullable: true })
  nextRetryAt?: Date;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Property({ fieldName: "processed_at", type: "timestamptz", nullable: true })
  processedAt?: Date;
}
