import { describe, expect, it } from "vitest";
import { adminPayloadHash, mintAdminSession, verifyAdminSession } from "./admin-session";

const KEY = "test-admin-key-0123456789abcdef";
const NOW = new Date("2026-08-07T12:00:00Z");

describe("admin step-up session tokens (M6, ADR 22)", () => {
  it("mints a token that verifies and pins the operator identity", () => {
    const { token, expiresAt } = mintAdminSession(KEY, "ops-ana", NOW);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + 15 * 60_000);
    expect(verifyAdminSession(KEY, token, NOW)).toBe("ops-ana");
  });

  it("rejects wrong key, tampered payload and expiry", () => {
    const { token } = mintAdminSession(KEY, "ops-ana", NOW);
    expect(verifyAdminSession("other-key", token, NOW)).toBeNull();
    const [v, op, exp] = token.split(".");
    const tampered = `${v}.${Buffer.from("mallory").toString("base64url")}.${exp}.AAAA`;
    expect(verifyAdminSession(KEY, tampered, NOW)).toBeNull();
    expect(verifyAdminSession(KEY, token, new Date(NOW.getTime() + 16 * 60_000))).toBeNull();
    expect(verifyAdminSession(KEY, "garbage", NOW)).toBeNull();
  });

  it("payload hash is canonical for the action log", () => {
    const a = adminPayloadHash({ days: 7, reason: "x" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(adminPayloadHash({ days: 7, reason: "x" })).toBe(a);
    expect(adminPayloadHash({ days: 8, reason: "x" })).not.toBe(a);
  });
});
