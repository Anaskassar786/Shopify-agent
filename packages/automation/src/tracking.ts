import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TrackingTokenKind } from "@profit/types";

/**
 * Stateless signed tracking tokens (M6). The public endpoints (/t/o, /t/c,
 * /t/u) run WITHOUT a tenant session — the HMAC signature over the payload
 * IS the authorization: a token can only be minted by the platform (secret
 * never leaves the server) and only addresses the exact recipient/kind/url
 * embedded in it. Tokens carry no expiry on purpose: an email opened months
 * later is still a truthful signal (M6 doc §5 threat model).
 *
 * Format: v1.<base64url(payloadJson)>.<base64url(hmac-sha256)> — URL-safe,
 * 200-char-capped click URLs so every link fits any email client.
 */

interface TokenPayloadV1 {
  readonly v: 1;
  readonly k: (typeof TrackingTokenKind)[keyof typeof TrackingTokenKind];
  /** campaign_recipients.id */
  readonly r: string;
  /** Click target — present only for click tokens. */
  readonly u?: string;
}

export interface TrackingTokenInput {
  readonly kind: (typeof TrackingTokenKind)[keyof typeof TrackingTokenKind];
  readonly recipientId: string;
  readonly url?: string;
}

export interface VerifiedTrackingToken {
  readonly kind: (typeof TrackingTokenKind)[keyof typeof TrackingTokenKind];
  readonly recipientId: string;
  readonly url: string | null;
}

export class TrackingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingTokenError";
  }
}

const MAX_CLICK_URL_LENGTH = 2000;
const PREFIX = "v1";

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function sign(secret: string, encodedPayload: string): string {
  return b64url(createHmac("sha256", secret).update(encodedPayload).digest());
}

export function mintTrackingToken(secret: string, input: TrackingTokenInput): string {
  if (secret.length < 16) {
    throw new TrackingTokenError("tracking secret must be at least 16 characters");
  }
  if (input.kind === TrackingTokenKind.Click) {
    if (input.url === undefined || !/^https?:\/\//i.test(input.url)) {
      throw new TrackingTokenError("click tokens require an http(s) url");
    }
  } else if (input.url !== undefined) {
    throw new TrackingTokenError("url is only allowed on click tokens");
  }
  const payload: TokenPayloadV1 = {
    v: 1,
    k: input.kind,
    r: input.recipientId,
    ...(input.url !== undefined ? { u: input.url.slice(0, MAX_CLICK_URL_LENGTH) } : {}),
  };
  const encodedPayload = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${PREFIX}.${encodedPayload}.${sign(secret, encodedPayload)}`;
}

/** Verify signature + shape. Throws TrackingTokenError on any tamper/shape break. */
export function verifyTrackingToken(secret: string, token: string): VerifiedTrackingToken {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new TrackingTokenError("malformed tracking token");
  }
  const encodedPayload = parts[1]!;
  const encodedSig = parts[2]!;
  const expected = Buffer.from(sign(secret, encodedPayload), "utf8");
  const provided = Buffer.from(encodedSig, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new TrackingTokenError("invalid tracking token signature");
  }
  let payload: TokenPayloadV1;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as TokenPayloadV1;
  } catch {
    throw new TrackingTokenError("undecodable tracking token payload");
  }
  if (
    payload.v !== 1 ||
    !Object.values(TrackingTokenKind).includes(payload.k) ||
    typeof payload.r !== "string" ||
    payload.r.length !== 36
  ) {
    throw new TrackingTokenError("invalid tracking token payload");
  }
  if (payload.k === TrackingTokenKind.Click) {
    if (typeof payload.u !== "string" || !/^https?:\/\//i.test(payload.u)) {
      throw new TrackingTokenError("click token missing destination");
    }
    return { kind: payload.k, recipientId: payload.r, url: payload.u };
  }
  return { kind: payload.k, recipientId: payload.r, url: null };
}

/**
 * 1×1 transparent GIF89a (42 bytes) — served by /t/o with no-store headers.
 * Byte-exact constant so tests pin the payload hash.
 */
export const TRACKING_PIXEL_GIF: Buffer = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

export const TRACKING_PIXEL_SHA256 = createHash("sha256")
  .update(TRACKING_PIXEL_GIF)
  .digest("hex");

/** Rewrite rules applied to an email HTML body before send (tracking injection). */
export function injectTracking(
  html: string,
  urls: { readonly openUrl: string; readonly clickUrlFor: (target: string) => string },
): string {
  const { openUrl, clickUrlFor } = urls;
  // Rewrite http(s) hrefs through the click tracker. Anchors/mailto stay direct.
  const withClicks = html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (_whole, target: string) => `href="${clickUrlFor(target)}"`,
  );
  return `${withClicks}<img src="${openUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
}
