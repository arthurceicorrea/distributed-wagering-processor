export interface AuthenticatedProviderIdentity {
  providerId: string;
  subject: string;
  scopes: string[];
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

export interface ProviderIdentityPort {
  verifyToken(authorizationHeader?: string): Promise<AuthenticatedProviderIdentity | null>;
}
