import { CurrencyMismatchError, DomainError, FailureCode } from "./errors";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry; openingTransactionId?: string } {
    if (!props.playerId || props.playerId.trim() === "") {
      throw new DomainError("playerId is required", "INVALID_PLAYER_ID");
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainError("Initial balance cannot be negative", FailureCode.InsufficientFunds);
    }

    const now = props.now ?? new Date();
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );

    if (props.initialBalance.isPositive()) {
      const openingTxId = crypto.randomUUID();
      const openingEntry = WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        walletId: wallet.id,
        transactionId: openingTxId,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: props.initialBalance,
        createdAt: now,
      });
      return { wallet, openingEntry, openingTransactionId: openingTxId };
    }

    return { wallet };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(params: {
    transactionId: string;
    entryId: string;
    money: Money;
    at?: Date;
    failureCodeOnInsufficient?: FailureCode;
  }): WalletLedgerEntry {
    this.assertSameCurrency(params.money);
    if (!params.money.isPositive()) {
      throw new DomainError("Debit amount must be positive", "INVALID_DEBIT_AMOUNT");
    }
    if (this._balance.isLessThan(params.money)) {
      throw new DomainError(
        `Insufficient funds in wallet ${this.id}`,
        params.failureCodeOnInsufficient ?? FailureCode.InsufficientFunds,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(params.money);
    const now = params.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  credit(params: {
    transactionId: string;
    entryId: string;
    money: Money;
    at?: Date;
  }): WalletLedgerEntry {
    this.assertSameCurrency(params.money);
    if (!params.money.isPositive()) {
      throw new DomainError("Credit amount must be positive", "INVALID_CREDIT_AMOUNT");
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(params.money);
    const now = params.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
