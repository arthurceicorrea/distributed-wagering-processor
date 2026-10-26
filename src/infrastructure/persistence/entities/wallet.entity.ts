import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"], name: "uq_wallets_player_currency" })
export class WalletEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "player_id", type: "varchar", length: 128 })
  playerId!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({
    fieldName: "balance_amount",
    columnType: "numeric(19,2)",
    type: "string",
  })
  balanceAmount!: string;

  @Property({ type: "integer" })
  version!: number;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Property({ fieldName: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
