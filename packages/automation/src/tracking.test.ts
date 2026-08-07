import { describe, expect, it } from "vitest";
import { TrackingTokenKind } from "@profit/types";
import {
  injectTracking,
  mintTrackingToken,
  TRACKING_PIXEL_GIF,
  TRACKING_PIXEL_SHA256,
  TrackingTokenError,
  verifyTrackingToken,
} from "./tracking";
import { createHash, createHmac } from "node:crypto";

const SECRET = "test-tracking-secret-0123456789abcdef";
const RECIPIENT = "7f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d";

describe("tracking tokens", () => {
  it("mints and verifies an open token (round-trip)", () => {
    const token = mintTrackingToken(SECRET, { kind: TrackingTokenKind.Open, recipientId: RECIPIENT });
    const verified = verifyTrackingToken(SECRET, token);
    expect(verified).toEqual({ kind: TrackingTokenKind.Open, recipientId: RECIPIENT, url: null });
  });

  it("mints and verifies a click token with its destination", () => {
    const token = mintTrackingToken(SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId: RECIPIENT,
      url: "https://shop.example.com/products/sneakers?utm=winback",
    });
    const verified = verifyTrackingToken(SECRET, token);
    expect(verified.kind).toBe(TrackingTokenKind.Click);
    expect(verified.url).toBe("https://shop.example.com/products/sneakers?utm=winback");
  });

  it("url stays parseable in the token (base64url)", () => {
    const token = mintTrackingToken(SECRET, {
      kind: TrackingTokenKind.Click,
      recipientId: RECIPIENT,
      url: "https://shop.example.com/?a=1&b=2",
    });
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("rejects tampered payloads", () => {
    const token = mintTrackingToken(SECRET, { kind: TrackingTokenKind.Open, recipientId: RECIPIENT });
    const [v, payload, sig] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, k: "open", r: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    ).toString("base64url");
    expect(() => verifyTrackingToken(SECRET, `${v}.${forgedPayload}.${sig}`)).toThrow(TrackingTokenError);
    void payload;
  });

  it("rejects tokens from a different secret", () => {
    const token = mintTrackingToken(SECRET, { kind: TrackingTokenKind.Open, recipientId: RECIPIENT });
    expect(() => verifyTrackingToken(`${SECRET}x`, token)).toThrow(/signature/);
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyTrackingToken(SECRET, "garbage")).toThrow(/malformed/);
    expect(() => verifyTrackingToken(SECRET, "v2.abc.def")).toThrow(/malformed/);
    expect(() => verifyTrackingToken(SECRET, "v1..x")).toThrow(TrackingTokenError);
  });

  it("rejects payloads with wrong shapes after valid signature", () => {
    // Hand-sign a structurally-bad payload (proves verification is shape-aware).
    const bad = Buffer.from(JSON.stringify({ v: 9, k: "open", r: "short" })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(bad).digest("base64url");
    expect(() => verifyTrackingToken(SECRET, `v1.${bad}.${sig}`)).toThrow(/payload/);
  });

  it("enforces construction rules", () => {
    expect(() => mintTrackingToken("short", { kind: TrackingTokenKind.Open, recipientId: RECIPIENT })).toThrow(
      /at least 16/,
    );
    expect(() =>
      mintTrackingToken(SECRET, { kind: TrackingTokenKind.Click, recipientId: RECIPIENT }),
    ).toThrow(/http\(s\) url/);
    expect(() =>
      mintTrackingToken(SECRET, { kind: TrackingTokenKind.Click, recipientId: RECIPIENT, url: "ftp://x" }),
    ).toThrow(/http\(s\) url/);
    expect(() =>
      mintTrackingToken(SECRET, { kind: TrackingTokenKind.Open, recipientId: RECIPIENT, url: "https://x.io" }),
    ).toThrow(/only allowed on click/);
  });
});

describe("tracking pixel", () => {
  it("is the byte-exact 42-byte transparent gif with a pinned hash", () => {
    expect(TRACKING_PIXEL_GIF.length).toBe(42);
    expect(TRACKING_PIXEL_GIF.slice(0, 6).toString("ascii")).toBe("GIF89a");
    expect(createHash("sha256").update(TRACKING_PIXEL_GIF).digest("hex")).toBe(TRACKING_PIXEL_SHA256);
  });
});

describe("injectTracking", () => {
  it("rewrites http links through the click tracker and appends the pixel", () => {
    const html = `<p>Hi</p><a href="https://shop.example.com/p/1">Shop</a><a href="mailto:x@y.z">Mail</a><a href="#top">Top</a>`;
    const out = injectTracking(html, {
      openUrl: "https://api.example.com/api/v1/t/o/TOK",
      clickUrlFor: (target) => `https://api.example.com/api/v1/t/c/ENC(${target})`,
    });
    expect(out).toContain('href="https://api.example.com/api/v1/t/c/ENC(https://shop.example.com/p/1)"');
    expect(out).toContain('href="mailto:x@y.z"');
    expect(out).toContain('href="#top"');
    expect(out).toContain('<img src="https://api.example.com/api/v1/t/o/TOK"');
  });

  it("handles bodies without links", () => {
    const out = injectTracking("<p>plain</p>", {
      openUrl: "https://o",
      clickUrlFor: (t) => t,
    });
    expect(out).toContain("<p>plain</p>");
    expect(out).toContain("<img");
  });
});
