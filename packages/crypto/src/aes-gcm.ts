import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM authenticated encryption for at-rest secrets (P12: Shopify access
 * tokens stored encrypted, never exposed). Payload format is versioned and
 * self-contained so the schema stores a single text column:
 *
 *   base64url( "v1" || iv(12) || authTag(16) || ciphertext )
 *
 * Rotation (P5: rotation without downtime): decryption tries the current key
 * first, then the previous key; rows decrypt transparently across a rotation
 * window and are re-encrypted on next write. Keys arrive via ENCRYPTION_KEY /
 * ENCRYPTION_KEY_PREVIOUS as base64 (preferred) or hex, 32 bytes decoded.
 */

const IV_BYTES = 12; // 96-bit nonce — the GCM recommendation
const TAG_BYTES = 16;
const VERSION_BYTE = 0x01;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

export class DecryptionError extends Error {
  constructor(message = "ciphertext failed integrity verification") {
    super(message);
    this.name = "DecryptionError";
  }
}

function decodeKey(label: string, material: string): Buffer {
  const trimmed = material.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, "hex"));
  const asBase64 = Buffer.from(trimmed, "base64");
  if (asBase64.length > 0) candidates.push(asBase64);
  for (const candidate of candidates) {
    if (candidate.length === 32) return candidate;
  }
  throw new EncryptionKeyError(
    `${label} must decode to 32 bytes (base64 or hex encoded AES-256 key)`,
  );
}

export class EncryptionService {
  private readonly currentKey: Buffer;
  private readonly previousKey?: Buffer;

  private constructor(currentKey: Buffer, previousKey?: Buffer) {
    this.currentKey = currentKey;
    if (previousKey !== undefined) this.previousKey = previousKey;
  }

  /** Build from raw key strings (validated). Throws EncryptionKeyError on bad material. */
  static create(currentKeyMaterial: string, previousKeyMaterial?: string): EncryptionService {
    const current = decodeKey("ENCRYPTION_KEY", currentKeyMaterial);
    if (previousKeyMaterial === undefined) return new EncryptionService(current);
    return new EncryptionService(current, decodeKey("ENCRYPTION_KEY_PREVIOUS", previousKeyMaterial));
  }

  /** Deterministic 32-byte key for tests only — still real AES-GCM, not a mock. */
  static forTestKey(seed: number): EncryptionService {
    const key = Buffer.alloc(32);
    key.writeUInt32BE(seed >>> 0, 0);
    return new EncryptionService(key);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.currentKey, iv, { authTagLength: TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([Buffer.from([VERSION_BYTE]), iv, tag, ciphertext]);
    return payload.toString("base64url");
  }

  decrypt(payload: string): string {
    const raw = Buffer.from(payload, "base64url");
    if (raw.length < 1 + IV_BYTES + TAG_BYTES + 1 || raw[0] !== VERSION_BYTE) {
      throw new DecryptionError("unrecognized ciphertext format");
    }
    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(1 + IV_BYTES + TAG_BYTES);

    const keys: Buffer[] =
      this.previousKey !== undefined ? [this.currentKey, this.previousKey] : [this.currentKey];
    for (const key of keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Wrong key or corrupt payload — try the rotation key, else fail below.
      }
    }
    throw new DecryptionError();
  }

  /** Constant-time comparison helper for key fingerprints in tests/ops. */
  fingerprintEquals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
