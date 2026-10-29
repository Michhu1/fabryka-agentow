import { hkdfSync } from 'node:crypto';

/** Purposes a key can be derived for; each gets an independent key from the single ENCRYPTION_KEY. */
export type KeyPurpose = 'auth-jwt' | 'data-encryption';

/**
 * Derives a 32-byte key for one purpose via HKDF-SHA256 (purpose as the `info` label), so a leak or
 * misuse of one derived key (e.g. the JWT secret) does not expose the others.
 */
export function deriveKey(encryptionKey: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', encryptionKey, '', purpose, 32));
}
