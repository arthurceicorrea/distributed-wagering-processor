import { describe, expect, it } from "bun:test";
import { computeCanonicalPayloadHash } from "../src/application/canonical-hash";
import {
  CurrencyMismatchError,
  FailureCode,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from "../src/domain/errors";
import { Money } from "../src/domain/money";
import {
  assertNonEmptyString,
  assertValidExternalKind,
  assertValidUuid,
} from "../src/domain/validation";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../src/domain/wager-transaction";
import { Wallet } from "../src/domain/wallet";
import { LedgerDirection } from "../src/domain/wallet-ledger-entry";

describe("Modelo de domínio e regras financeiras", () => {
  describe("Money", () => {
    it("mantém a escala monetária e faz aritmética exata", () => {
      const a = Money.from({ amount: "100.00", currency: "BRL" });
      const b = Money.from({ amount: "80.00", currency: "BRL" });
      const diff = a.subtract(b);
      expect(diff.toJSON()).toEqual({ amount: "20.00", currency: "BRL" });
      expect(diff.isPositive()).toBe(true);
    });

    it("recusa valores inválidos e formatos fora da escala", () => {
      const invalidAmounts = [
        "NaN",
        "Infinity",
        "1e2",
        "25.000",
        "25.5",
        "",
        "-10.00",
      ];
      for (const amount of invalidAmounts) {
        expect(() => Money.from({ amount, currency: "BRL" })).toThrow(
          InvalidMoneyError,
        );
      }
    });

    it("impede operações entre moedas diferentes", () => {
      const brl = Money.from({ amount: "10.00", currency: "BRL" });
      const usd = Money.from({ amount: "10.00", currency: "USD" });
      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe("Carteira e razão", () => {
    it("registra o lançamento inicial e começa na versão 1", () => {
      const { wallet, openingEntry } = Wallet.open({
        id: crypto.randomUUID(),
        playerId: "player-1",
        initialBalance: Money.from({ amount: "500.00", currency: "BRL" }),
      });

      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON().amount).toBe("500.00");
      expect(openingEntry).toBeDefined();
      expect(openingEntry!.isBalanced()).toBe(true);
    });

    it("altera a versão no débito e não permite saldo negativo", () => {
      const { wallet } = Wallet.open({
        id: crypto.randomUUID(),
        playerId: "player-1",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      const entry = wallet.debit({
        transactionId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        money: Money.from({ amount: "80.00", currency: "BRL" }),
      });

      expect(wallet.balance.toJSON().amount).toBe("20.00");
      expect(wallet.version).toBe(2);
      expect(entry.isBalanced()).toBe(true);

      expect(() =>
        wallet.debit({
          transactionId: crypto.randomUUID(),
          entryId: crypto.randomUUID(),
          money: Money.from({ amount: "80.00", currency: "BRL" }),
        }),
      ).toThrow();
      expect(wallet.version).toBe(2);
    });
  });

  describe("Regras das transações", () => {
    it("exige referência para estornos e reserva OPENING para uso interno", () => {
      expect(() =>
        WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: "p1",
          externalTransactionId: "ext-1",
          idempotencyKey: "p1:ext-1",
          payloadHash: "hash",
          walletId: crypto.randomUUID(),
          playerId: "pl-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Opening,
          money: Money.from({ amount: "10.00", currency: "BRL" }),
        }),
      ).toThrow();

      expect(() =>
        WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: "p1",
          externalTransactionId: "ext-2",
          idempotencyKey: "p1:ext-2",
          payloadHash: "hash",
          walletId: crypto.randomUUID(),
          playerId: "pl-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Refund,
          money: Money.from({ amount: "10.00", currency: "BRL" }),
        }),
      ).toThrow();
    });

    it("encerra a transação e define o sentido do rollback", () => {
      const betTx = WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: "p1",
        externalTransactionId: "bet-1",
        idempotencyKey: "p1:bet-1",
        payloadHash: "h1",
        walletId: crypto.randomUUID(),
        playerId: "pl-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
      });

      betTx.markProcessed(undefined, new Date());
      expect(betTx.isTerminal()).toBe(true);
      expect(() => betTx.reject(FailureCode.InsufficientFunds)).toThrow(
        InvalidTransactionStateError,
      );

      const rollbackTx = WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: "p1",
        externalTransactionId: "rb-1",
        idempotencyKey: "p1:rb-1",
        payloadHash: "h2",
        walletId: betTx.walletId,
        playerId: "pl-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Rollback,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        referenceExternalTransactionId: "bet-1",
      });

      expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
    });

    it("produz hashes diferentes para payloads diferentes", () => {
      const base = {
        providerId: "provider-a",
        externalTransactionId: "tx-1",
        playerId: "player-1",
        walletId: "wallet-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      };

      const hash1 = computeCanonicalPayloadHash(base);
      const hash2 = computeCanonicalPayloadHash({
        ...base,
        money: { amount: "50.00", currency: "BRL" },
      });

      expect(hash1).not.toBe(hash2);
    });

    it("aplica as regras de WIN e LOSS no saldo", () => {
      const lossTx = WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: "p1",
        externalTransactionId: "loss-1",
        idempotencyKey: "p1:loss-1",
        payloadHash: "h-loss",
        walletId: crypto.randomUUID(),
        playerId: "pl-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Loss,
        money: Money.zero("BRL"),
      });

      expect(lossTx.affectsBalance()).toBe(false);
      expect(() => lossTx.ledgerDirectionFor()).toThrow();

      const winTx = WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: "p1",
        externalTransactionId: "win-1",
        idempotencyKey: "p1:win-1",
        payloadHash: "h-win",
        walletId: crypto.randomUUID(),
        playerId: "pl-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Win,
        money: Money.from({ amount: "150.00", currency: "BRL" }),
      });

      expect(winTx.affectsBalance()).toBe(true);
      expect(winTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it("valida identificadores e campos obrigatórios", () => {
      expect(() => assertValidUuid("not-a-uuid", "walletId")).toThrow();
      expect(() => assertNonEmptyString("   ", "providerId")).toThrow();
      expect(() => assertValidExternalKind("OPENING")).toThrow();
      const sampleId = crypto.randomUUID();
      expect(assertValidUuid(sampleId, "walletId")).toBe(sampleId);
    });
  });
});
