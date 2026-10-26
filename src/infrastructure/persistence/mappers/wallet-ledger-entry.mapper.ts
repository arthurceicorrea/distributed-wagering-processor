import { WalletLedgerEntry } from "../../../domain/wallet-ledger-entry";
import { WalletLedgerEntryEntity } from "../entities/wallet-ledger-entry.entity";

export class WalletLedgerEntryMapper {
  static toEntity(domain: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = domain.id;
    entity.walletId = domain.walletId;
    entity.transactionId = domain.transactionId;
    entity.direction = domain.direction;
    entity.amount = domain.money.toJSON().amount;
    entity.currency = domain.money.currency;
    entity.balanceBeforeAmount = domain.balanceBefore.toJSON().amount;
    entity.balanceAfterAmount = domain.balanceAfter.toJSON().amount;
    entity.createdAt = domain.createdAt;
    return entity;
  }
}
