import type { AdminSessionResponse } from "../lib/api-types";

/**
 * M6 admin step-up session: the 15-minute HMAC token that authorizes WRITE
 * calls on the operator console. Deliberately stored in sessionStorage —
 * it survives a page reload (operator convenience inside one sitting) but
 * dies with the tab, and its own expiry is always re-checked on load.
 *
 * The platform admin KEY itself is never stored anywhere (M5 rule intact).
 */

export interface AdminSession {
  readonly token: string;
  readonly operatorId: string;
  readonly expiresAt: string;
}

const KEY = "profit.adminSession.v1";

export function loadAdminSession(storage: Storage = window.sessionStorage): AdminSession | null {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["token"] !== "string" || typeof candidate["operatorId"] !== "string" || typeof candidate["expiresAt"] !== "string") {
      return null;
    }
    if (Date.parse(candidate["expiresAt"]) <= Date.now()) {
      storage.removeItem(KEY);
      return null;
    }
    return { token: candidate["token"], operatorId: candidate["operatorId"], expiresAt: candidate["expiresAt"] };
  } catch {
    return null;
  }
}

export function saveAdminSession(session: AdminSession, storage: Storage = window.sessionStorage): void {
  storage.setItem(KEY, JSON.stringify(session));
}

export function clearAdminSession(storage: Storage = window.sessionStorage): void {
  storage.removeItem(KEY);
}

export function sessionFromResponse(response: AdminSessionResponse): AdminSession {
  return { token: response.token, operatorId: response.operatorId, expiresAt: response.expiresAt };
}
