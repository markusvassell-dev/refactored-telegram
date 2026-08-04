import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric crypto helpers.
 *
 * - `encryptSecret` / `decryptSecret` protect integration credentials at rest.
 * - `seal` / `unseal` back the session cookie.
 * - `signPayload` / `verifySignature` back webhook verification and signed
 *   temporary download links.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';

export function normaliseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Accept hex, base64, or a passphrase (which is stretched deterministically).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const asBase64 = Buffer.from(trimmed, 'base64');
  if (asBase64.length === KEY_BYTES) return asBase64;
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

function deriveKey(masterKey: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', normaliseKey(masterKey), Buffer.alloc(0), Buffer.from(purpose, 'utf8'), KEY_BYTES));
}

export interface EncryptedValue {
  /** `v1.<purpose>.<iv>.<tag>.<ciphertext>` — all components base64url. */
  readonly serialized: string;
}

export function encryptSecret(plaintext: string, masterKey: string, purpose = 'integration-secret'): string {
  const key = deriveKey(masterKey, purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, purpose, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

export function decryptSecret(serialized: string, masterKey: string): string {
  const parts = serialized.split('.');
  if (parts.length !== 5) throw new Error('Malformed encrypted value');
  const [version, purpose, ivPart, tagPart, dataPart] = parts as [string, string, string, string, string];
  if (version !== VERSION) throw new Error(`Unsupported ciphertext version: ${version}`);

  const key = deriveKey(masterKey, purpose);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Encrypts and authenticates an arbitrary JSON payload (session cookies). */
export function seal(payload: unknown, secret: string, purpose = 'session'): string {
  return encryptSecret(JSON.stringify(payload), secret, purpose);
}

export function unseal<T>(serialized: string, secret: string): T | null {
  try {
    return JSON.parse(decryptSecret(serialized, secret)) as T;
  } catch {
    return null;
  }
}

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', normaliseKey(secret)).update(payload, 'utf8').digest('base64url');
}

/** Constant-time comparison that never throws on malformed input. */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signPayload(payload, secret), 'utf8');
  const provided = Buffer.from(signature ?? '', 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Compares two secrets in constant time regardless of length. */
export function safeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a ?? '', 'utf8').digest();
  const hb = createHash('sha256').update(b ?? '', 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    .digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
