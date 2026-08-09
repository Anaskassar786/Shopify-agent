import { createHash, randomBytes } from "node:crypto";
import { createSecretKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { UserRole } from "@profit/types";
import { AuthenticationError } from "../../lib/errors";

/**
 * First-party token issuer (P2: JWT + refresh rotation). Access tokens are
 * short-lived signed JWTs carrying role/permission claims (15 min default);
 * refresh tokens are opaque random strings — only their SHA-256 hash is
 * persisted, so a database leak yields nothing replayable.
 */

export const APP_JWT_ISSUER = "profit-tool-ai";
export const APP_JWT_AUDIENCE = "profit-api";

const claimsSchema = z.object({
  sub: z.string().uuid(),
  sid: z.string().uuid(),
  storeId: z.string().uuid(),
  role: z.nativeEnum(UserRole),
  perms: z.array(z.string()),
});

export interface AppAuthClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly role: (typeof UserRole)[keyof typeof UserRole];
  readonly permissions: readonly string[];
}

export interface JwtServiceConfig {
  readonly accessSecret: string;
  readonly accessTtlSeconds: number;
}

export class JwtService {
  private readonly key: ReturnType<typeof createSecretKey>;
  private readonly ttlSeconds: number;

  constructor(config: JwtServiceConfig) {
    this.key = createSecretKey(Buffer.from(config.accessSecret, "utf8"));
    this.ttlSeconds = config.accessTtlSeconds;
  }

  get accessTtlSeconds(): number {
    return this.ttlSeconds;
  }

  async signAccessToken(claims: AppAuthClaims): Promise<string> {
    return new SignJWT({
      sid: claims.sessionId,
      storeId: claims.storeId,
      role: claims.role,
      perms: [...claims.permissions],
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(APP_JWT_ISSUER)
      .setAudience(APP_JWT_AUDIENCE)
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setJti(randomBytes(16).toString("hex"))
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AppAuthClaims> {
    let payload;
    try {
      const verified = await jwtVerify(token, this.key, {
        issuer: APP_JWT_ISSUER,
        audience: APP_JWT_AUDIENCE,
        algorithms: ["HS256"],
      });
      payload = verified.payload;
    } catch {
      throw new AuthenticationError("invalid or expired access token");
    }
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AuthenticationError("access token claims malformed");
    }
    return {
      userId: parsed.data.sub,
      sessionId: parsed.data.sid,
      storeId: parsed.data.storeId,
      role: parsed.data.role,
      permissions: parsed.data.perms,
    };
  }
}

/** Opaque refresh token helpers — raw value returned to client once. */
export function mintRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
