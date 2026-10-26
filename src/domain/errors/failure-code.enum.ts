export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  InvalidReferenceContext = "INVALID_REFERENCE_CONTEXT",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",
  ReferenceNotFoundTimeout = "REFERENCE_NOT_FOUND_TIMEOUT",
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}
