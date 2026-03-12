import { createSecretKey } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type {
  JwtServerAuthConfig,
  SharedSecretAuthConfig,
  TunnelServerAuthConfig,
} from "../config.js";
import type { HelloAuth } from "../reliable/types.js";

export type AuthenticatedIdentity = {
  authType: "shared-secret" | "jwt";
  subject: string;
  issuer?: string;
  scopes: string[];
  claims?: JWTPayload;
};

export class TunnelAuthenticationError extends Error {}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function getJwtKeyResolver(config: JwtServerAuthConfig): ReturnType<typeof createSecretKey> | JWTVerifyGetKey {
  if (config.secret) {
    return createSecretKey(Buffer.from(config.secret, "utf8"));
  }

  const cached = jwksCache.get(config.jwksUrl!);
  if (cached) {
    return cached;
  }

  const resolver = createRemoteJWKSet(new URL(config.jwksUrl!));
  jwksCache.set(config.jwksUrl!, resolver);
  return resolver;
}

function extractScopes(payload: JWTPayload): string[] {
  const scopeClaim = payload.scope;
  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(" ")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  const scpClaim = payload.scp;
  if (Array.isArray(scpClaim)) {
    return scpClaim.filter((value): value is string => typeof value === "string");
  }

  if (typeof scpClaim === "string") {
    return [scpClaim];
  }

  return [];
}

function verifySharedSecret(auth: SharedSecretAuthConfig, helloAuth: HelloAuth): AuthenticatedIdentity {
  if (helloAuth.type !== "shared_secret") {
    throw new TunnelAuthenticationError("Expected shared secret client authentication.");
  }

  if (helloAuth.secret !== auth.secret) {
    throw new TunnelAuthenticationError("Invalid shared secret.");
  }

  return {
    authType: "shared-secret",
    subject: "shared-secret-client",
    scopes: [],
  };
}

async function verifyJwt(config: JwtServerAuthConfig, helloAuth: HelloAuth): Promise<AuthenticatedIdentity> {
  if (helloAuth.type !== "bearer") {
    throw new TunnelAuthenticationError("Expected bearer token client authentication.");
  }

  const verificationOptions = {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: config.algorithms,
    clockTolerance: config.clockToleranceSec,
  } as const;

  const keyResolver = getJwtKeyResolver(config);
  const result =
    typeof keyResolver === "function"
      ? await jwtVerify(helloAuth.token, keyResolver, verificationOptions)
      : await jwtVerify(helloAuth.token, keyResolver, verificationOptions);

  if (!result.payload.sub) {
    throw new TunnelAuthenticationError("JWT is missing required subject claim.");
  }

  const scopes = extractScopes(result.payload);
  const missingScopes = config.requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new TunnelAuthenticationError(
      `JWT is missing required scopes: ${missingScopes.join(", ")}.`,
    );
  }

  return {
    authType: "jwt",
    subject: result.payload.sub,
    scopes,
    claims: result.payload,
    ...(result.payload.iss ? { issuer: result.payload.iss } : {}),
  };
}

export async function authenticateTunnelClient(
  auth: TunnelServerAuthConfig,
  helloAuth: HelloAuth,
): Promise<AuthenticatedIdentity> {
  if (auth.mode === "shared-secret") {
    return verifySharedSecret(auth, helloAuth);
  }

  return verifyJwt(auth, helloAuth);
}