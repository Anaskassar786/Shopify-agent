import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  EncryptionKeyError,
  EncryptionService,
} from "./aes-gcm";

function keyMaterial(seed: number): string {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(seed, 0);
  return raw.toString("base64");
}

describe("EncryptionService (AES-256-GCM)", () => {
  it("round-trips secrets", () => {
    const service = EncryptionService.create(keyMaterial(7));
    const token = "fixture_offline_token_plaintext_marker_01";
    const encrypted = service.encrypt(token);
    expect(encrypted).not.toContain("fixture_offline");
    expect(service.decrypt(encrypted)).toBe(token);
  });

  it("produces unique ciphertexts for identical plaintext (random IV)", () => {
    const service = EncryptionService.create(keyMaterial(7));
    expect(service.encrypt("same")).not.toBe(service.encrypt("same"));
  });

  it("detects tampering — integrity tag verification fails", () => {
    const service = EncryptionService.create(keyMaterial(7));
    const encrypted = service.encrypt("sensitive");
    const raw = Buffer.from(encrypted, "base64url");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; // flip last ciphertext byte
    expect(() => service.decrypt(raw.toString("base64url"))).toThrow(DecryptionError);
  });

  it("rejects the wrong key", () => {
    const a = EncryptionService.create(keyMaterial(1));
    const b = EncryptionService.create(keyMaterial(2));
    expect(() => b.decrypt(a.encrypt("secret"))).toThrow(DecryptionError);
  });

  it("supports key rotation window: decrypts with previous key", () => {
    const oldKey = EncryptionService.create(keyMaterial(1));
    const legacyCiphertext = oldKey.encrypt("old token");
    const rotated = EncryptionService.create(keyMaterial(2), keyMaterial(1));
    expect(rotated.decrypt(legacyCiphertext)).toBe("old token");
    // New writes use the new key:
    const fresh = rotated.encrypt("new token");
    expect(() => oldKey.decrypt(fresh)).toThrow(DecryptionError);
    expect(rotated.decrypt(fresh)).toBe("new token");
  });

  it("accepts hex-encoded keys and rejects malformed material", () => {
    const hex = randomBytes(32).toString("hex");
    expect(() => EncryptionService.create(hex)).not.toThrow();
    expect(() => EncryptionService.create("not-a-key")).toThrow(EncryptionKeyError);
    expect(() => EncryptionService.create(Buffer.alloc(8).toString("base64"))).toThrow(
      EncryptionKeyError,
    );
  });

  it("rejects unrecognized ciphertext formats", () => {
    const service = EncryptionService.create(keyMaterial(7));
    expect(() => service.decrypt("bm90LWVuY3J5cHRlZA")).toThrow(DecryptionError);
  });
});
