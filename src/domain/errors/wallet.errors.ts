import { DomainError } from "./domain.error";

export class DuplicateWalletError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      `Wallet already exists for player '${playerId}' and currency '${currency}'`,
      "DUPLICATE_WALLET",
    );
  }
}

export class EntityNotFoundError extends DomainError {
  constructor(entity: string, identifier: string) {
    super(`${entity} '${identifier}' not found`, "ENTITY_NOT_FOUND");
  }
}
