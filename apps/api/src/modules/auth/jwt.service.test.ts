import { describe, expect, it } from "vitest";
import { UserRole } from "@profit/types";
import { AuthenticationError } from "../../lib/errors";
import { hashRefreshToken, JwtService, mintRefreshToken } from "./jwt.service";

const SECRET = "unit-test-access-secret";
const CLAIMS = {
  userId: "7b0a1e7c-6f2c-4b0a-8b0d-3f8b1a2c3d4e",
  sessionId: "11111111-2222-4333-8444-555555555555",
  storeId: "66666666-7777-4888-8999-000000000000",
  role: UserRole.Owner,
  permissions: ["store:read", "recommendations:approve"],
};

describe("JwtService", () => {
  it("round-trips signed claims with permission set", async () => {
    const service = new JwtService({ accessSecret: SECRET, accessTtlSeconds: 900 });
    const token = await service.signAccessToken(CLAIMS);
    const verified = await service.verifyAccessToken(token);
    expect(verified).toMatchObject(CLAIMS);
  });

  it("rejects tokens signed with a different secret", async () => {
    const a = new JwtService({ accessSecret: SECRET, accessTtlSeconds: 900 });
    const b = new JwtService({ accessSecret: "different-secret", accessTtlSeconds: 900 });
    const token = await a.signAccessToken(CLAIMS);
    await expect(b.verifyAccessToken(token)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects expired tokens", async () => {
    const service = new JwtService({ accessSecret: SECRET, accessTtlSeconds: 0 });
    // Sign with a plain zero TTL by minting manually via the service then
    // verifying after expiry (exp seconds resolution → wait 1.1s).
    const shortLived = new JwtService({ accessSecret: SECRET, accessTtlSeconds: 60 });
    void shortLived;
    const token = await service.signAccessToken(CLAIMS);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(service.verifyAccessToken(token)).rejects.toBeInstanceOf(AuthenticationError);
  }, 5000);
});

describe("refresh token hashing (P2: raw tokens never stored)", () => {
  it("hash is deterministic and differs from the raw token", () => {
    const raw = mintRefreshToken();
    const hash = hashRefreshToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
    expect(hashRefreshToken(raw)).toBe(hash);
  });

  it("different tokens produce different hashes", () => {
    expect(hashRefreshToken(mintRefreshToken())).not.toBe(hashRefreshToken(mintRefreshToken()));
  });
});
