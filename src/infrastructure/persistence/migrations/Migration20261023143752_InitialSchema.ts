import { Migration } from "@mikro-orm/migrations";

export class Migration20261023143752_InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "wallets" (
        "id" uuid not null,
        "player_id" varchar(128) not null,
        "currency" varchar(3) not null,
        "balance_amount" numeric(19,2) not null,
        "version" int not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_pkey" primary key ("id"),
        constraint "uq_wallets_player_currency" unique ("player_id", "currency"),
        constraint "chk_wallets_balance_non_negative" check (balance_amount >= 0.00),
        constraint "chk_wallets_version_positive" check (version >= 1)
      );
    `);

    this.addSql(`
      create table if not exists "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(128) not null,
        "external_transaction_id" varchar(128) not null,
        "idempotency_key" varchar(256) not null,
        "payload_hash" varchar(64) not null,
        "wallet_id" uuid not null,
        "player_id" varchar(128) not null,
        "round_id" varchar(128) not null,
        "game_id" varchar(128) not null,
        "kind" varchar(32) not null,
        "amount" numeric(19,2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" varchar(128) null,
        "reference_transaction_id" uuid null,
        "status" varchar(32) not null,
        "failure_code" varchar(64) null,
        "observed_balance_amount" numeric(19,2) null,
        "observed_balance_currency" varchar(3) null,
        "retry_attempts" int not null default 0,
        "next_retry_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_wallet_id_fkey" foreign key ("wallet_id") references "wallets" ("id") on update no action on delete restrict,
        constraint "wager_transactions_reference_transaction_id_fkey" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update no action on delete restrict,
        constraint "uq_wager_tx_idempotency_key" unique ("idempotency_key"),
        constraint "uq_wager_tx_provider_ext_id" unique ("provider_id", "external_transaction_id"),
        constraint "chk_wager_tx_amount_non_negative" check (amount >= 0.00),
        constraint "chk_wager_tx_ref_required" check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or (kind not in ('REFUND', 'ROLLBACK'))
        )
      );
    `);

    this.addSql(`
      create unique index if not exists "uq_wager_tx_reversal_once"
        on "wager_transactions" ("reference_transaction_id")
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);

    this.addSql(`
      create index if not exists "idx_wager_tx_wallet_created"
        on "wager_transactions" ("wallet_id", "created_at");
    `);

    this.addSql(`
      create index if not exists "idx_wager_tx_pending_ref_retry"
        on "wager_transactions" ("status", "next_retry_at")
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table if not exists "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(16) not null,
        "amount" numeric(19,2) not null,
        "currency" varchar(3) not null,
        "balance_before_amount" numeric(19,2) not null,
        "balance_after_amount" numeric(19,2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_id_fkey" foreign key ("wallet_id") references "wallets" ("id") on update no action on delete restrict,
        constraint "wallet_ledger_entries_transaction_id_fkey" foreign key ("transaction_id") references "wager_transactions" ("id") on update no action on delete restrict,
        constraint "uq_ledger_wallet_transaction" unique ("wallet_id", "transaction_id"),
        constraint "chk_ledger_direction" check (direction in ('DEBIT', 'CREDIT')),
        constraint "chk_ledger_amount_positive" check (amount > 0.00),
        constraint "chk_ledger_balances_non_negative" check (
          balance_before_amount >= 0.00 and balance_after_amount >= 0.00
        ),
        constraint "chk_ledger_arithmetic_balance" check (
          (direction = 'CREDIT' and balance_before_amount + amount = balance_after_amount)
          or
          (direction = 'DEBIT' and balance_before_amount - amount = balance_after_amount)
        )
      );
    `);

    this.addSql(`
      create index if not exists "idx_ledger_wallet_cursor"
        on "wallet_ledger_entries" ("wallet_id", "created_at" asc, "id" asc);
    `);

    this.addSql(`
      create or replace function prevent_ledger_mutation()
      returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is strictly immutable: % operations are forbidden', TG_OP
          using errcode = '55000';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`drop trigger if exists "trg_prevent_ledger_mutation" on "wallet_ledger_entries";`);

    this.addSql(`
      create trigger "trg_prevent_ledger_mutation"
        before update or delete on "wallet_ledger_entries"
        for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create table if not exists "inbox_messages" (
        "consumer_name" varchar(128) not null,
        "message_id" varchar(128) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
      );
    `);

    this.addSql(`
      create table if not exists "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" varchar(128) not null,
        "event_type" varchar(128) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null default now(),
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id")
      );
    `);

    this.addSql(`
      create index if not exists "idx_outbox_pending_schedule"
        on "outbox_messages" ("published_at", "next_attempt_at" asc)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists "trg_prevent_ledger_mutation" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists prevent_ledger_mutation();`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
