import { Migration } from "@mikro-orm/migrations";

export class Migration20261026090000_AddDomainChecks extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wallets"
        add constraint "chk_wallets_currency_iso4217"
          check (currency ~ '^[A-Z]{3}$');
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "chk_wager_tx_kind"
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        add constraint "chk_wager_tx_status"
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        add constraint "chk_wager_tx_currency_iso4217"
          check (currency ~ '^[A-Z]{3}$'),
        add constraint "chk_wager_tx_payload_hash_sha256"
          check (payload_hash ~ '^[0-9a-fA-F]{64}$'),
        add constraint "chk_wager_tx_observed_currency_iso4217"
          check (observed_balance_currency is null or observed_balance_currency ~ '^[A-Z]{3}$'),
        add constraint "chk_wager_tx_retry_attempts_non_negative"
          check (retry_attempts >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
        add constraint "chk_ledger_currency_iso4217"
          check (currency ~ '^[A-Z]{3}$');
    `);

    this.addSql(`
      alter table "inbox_messages"
        add constraint "chk_inbox_payload_hash_sha256"
          check (payload_hash ~ '^[0-9a-fA-F]{64}$');
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "inbox_messages"
        drop constraint if exists "chk_inbox_payload_hash_sha256";
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
        drop constraint if exists "chk_ledger_currency_iso4217";
    `);

    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "chk_wager_tx_kind",
        drop constraint if exists "chk_wager_tx_status",
        drop constraint if exists "chk_wager_tx_currency_iso4217",
        drop constraint if exists "chk_wager_tx_payload_hash_sha256",
        drop constraint if exists "chk_wager_tx_observed_currency_iso4217",
        drop constraint if exists "chk_wager_tx_retry_attempts_non_negative";
    `);

    this.addSql(`
      alter table "wallets"
        drop constraint if exists "chk_wallets_currency_iso4217";
    `);
  }
}
