import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Admin step-up sessions (M6, ADR 22). The static X-Platform-Admin-Key opens
 * the READ surface; every WRITE additionally requires an operator-bound,
 * short-lived session token minted by POST /admin/session — so a leaked key
 * alone cannot mutate production state, and every action row pins an
 * operator identity (who), payload hash (what), and ip (where).
 *
 * Token format: `v1.{operatorIdB64}.{expiresAtMs}.{sigB64}` where sig =
 * HMAC-SHA256(key, "{operatorIdB64}.{expiresAtMs}"). Stateless by design —
 * Railway runs multiple API replicas; a DB session table would force a
 * shared lookup on every write. 15-minute TTL forces re-auth cadence.
 */

export const ADMIN_SESSION_TTL_MS = 15 * 60_000;

const PREFIX = "v1";

function sign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function mintAdminSession(
  key: string,
  operatorId: string,
  now = new Date(),
): { readonly token: string; readonly expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  const operatorB64 = Buffer.from(operatorId, "utf8").toString("base64url");
  const payload = `${operatorB64}.${String(expiresAt.getTime())}`;
  return { token: `${PREFIX}.${payload}.${sign(key, payload)}`, expiresAt };
}

/** Returns the operator id, or null when the token is malformed/forged/expired. */
export function verifyAdminSession(key: string, token: string, now = new Date()): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const payload = `${parts[1]}.${parts[2]}`;
  const expected = Buffer.from(sign(key, payload), "utf8");
  const provided = Buffer.from(parts[3]!, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  const expiresAtMs = Number(parts[2]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return null;
  const operatorId = Buffer.from(parts[1]!, "base64url").toString("utf8").trim();
  return operatorId.length > 0 && operatorId.length <= 200 ? operatorId : null;
}

/** Canonical payload fingerprint persisted on every write action row. */
export function adminPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? {}), "utf8").digest("hex");
}
