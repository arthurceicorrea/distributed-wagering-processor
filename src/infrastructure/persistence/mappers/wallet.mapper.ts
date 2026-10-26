import { Money } from "../../../domain/money";
import { Wallet } from "../../../domain/wallet";
import { WalletEntity } from "../entities/wallet.entity";

export class WalletMapper {
  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balanceAmount,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  static toEntity(domain: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = domain.id;
    entity.playerId = domain.playerId;
    entity.currency = domain.currency;
    entity.balanceAmount = domain.balance.toJSON().amount;
    entity.version = domain.version;
    entity.createdAt = domain.createdAt;
    entity.updatedAt = domain.updatedAt;
    return entity;
  }

  static syncEntity(domain: Wallet, entity: WalletEntity): void {
    entity.balanceAmount = domain.balance.toJSON().amount;
    entity.version = domain.version;
    entity.updatedAt = domain.updatedAt;
  }
}
