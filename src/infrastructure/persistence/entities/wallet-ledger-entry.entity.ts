import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { LedgerDirection } from "../../../domain/wallet-ledger-entry";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({
  properties: ["walletId", "transactionId"],
  name: "uq_ledger_wallet_transaction",
})
@Index({
  properties: ["walletId", "createdAt", "id"],
  name: "idx_ledger_wallet_cursor",
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "transaction_id", type: "uuid" })
  transactionId!: string;

  @Property({ type: "varchar", length: 16 })
  direction!: LedgerDirection;

  @Property({ columnType: "numeric(19,2)", type: "string" })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({
    fieldName: "balance_before_amount",
    columnType: "numeric(19,2)",
    type: "string",
  })
  balanceBeforeAmount!: string;

  @Property({
    fieldName: "balance_after_amount",
    columnType: "numeric(19,2)",
    type: "string",
  })
  balanceAfterAmount!: string;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
