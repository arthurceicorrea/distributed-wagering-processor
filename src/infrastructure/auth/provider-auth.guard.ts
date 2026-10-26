import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { PROVIDER_IDENTITY_PORT } from "../../application/ports";
import type {
  AuthenticatedProviderIdentity,
  ProviderIdentityPort,
} from "../../application/ports";

@Injectable()
export class OidcProviderIdentityAdapter implements ProviderIdentityPort {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    if (process.env.OIDC_JWKS_URI) {
      this.jwks = createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URI));
    }
  }

  async verifyToken(
    authorizationHeader?: string,
  ): Promise<AuthenticatedProviderIdentity | null> {
    if (!this.jwks) {
      return {
        providerId: "unrestricted-local-provider",
        subject: "local-dev",
        scopes: ["wagering:write", "wallets:write"],
      };
    }

    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authorizationHeader.slice("Bearer ".length).trim();
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
    });

    return {
      providerId: (payload.provider_id as string) ?? (payload.azp as string) ?? "",
      subject: payload.sub ?? "",
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
    };
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const identity = await this.identityPort.verifyToken(
      req.headers["authorization"],
    );
    if (!identity) {
      throw new UnauthorizedException({
        error: "UNAUTHORIZED",
        message: "Valid OIDC Bearer token is required",
      });
    }

    const targetProviderId = req.body?.providerId ?? req.params?.providerId;
    if (
      identity.providerId !== "unrestricted-local-provider" &&
      targetProviderId &&
      identity.providerId !== targetProviderId
    ) {
      throw new ForbiddenException({
        error: "PROVIDER_IDENTITY_MISMATCH",
        message: `Authenticated provider '${identity.providerId}' cannot operate on behalf of '${targetProviderId}'`,
      });
    }

    req.providerIdentity = identity;
    return true;
  }
}
