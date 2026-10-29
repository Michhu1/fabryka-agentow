import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

/**
 * AES-256-GCM with a random 12-byte IV per message. Payload format: `v1:<iv b64>:<tag b64>:<data b64>`
 * (the version prefix lets us rotate the scheme later). Every decryption failure throws the same
 * generic error so callers and logs never learn why (bad format, wrong key or tampering).
 */
export function createCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error('Cipher key must be 32 bytes');

  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
    },

    decrypt(payload) {
      try {
        const parts = payload.split(':');
        if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('bad format');
        const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('bad format');
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
          'utf8',
        );
      } catch {
        throw new Error('Decryption failed');
      }
    },
  };
}
