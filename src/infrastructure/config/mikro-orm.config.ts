import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import {
  InboxMessageEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from "../persistence/entities";
import { Migration20261023143752_InitialSchema } from "../persistence/migrations/Migration20261023143752_InitialSchema";
import { Migration20261026090000_AddDomainChecks } from "../persistence/migrations/Migration20261026090000_AddDomainChecks";

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    "postgres://jungle:jungle_secret@localhost:5432/jungle_wagering",
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: "./dist/infrastructure/persistence/migrations",
    pathTs: "./src/infrastructure/persistence/migrations",
    snapshotName: ".snapshot-jungle_wagering",
    migrationsList: [
      {
        name: "Migration20261023143752_InitialSchema",
        class: Migration20261023143752_InitialSchema,
      },
      {
        name: "Migration20261026090000_AddDomainChecks",
        class: Migration20261026090000_AddDomainChecks,
      },
    ],
  },
  pool: {
    min: 2,
    max: 30,
  },
  allowGlobalContext: true,
});
