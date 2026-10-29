import { describe, expect, it } from 'vitest';
import { createCipher } from './cipher.js';
import { deriveKey } from './keys.js';
import {
  hashPassword,
  PASSWORD_POLICY_MESSAGE,
  randomToken,
  sha256,
  validatePasswordPolicy,
  verifyPassword,
} from './password.js';

const ENCRYPTION_KEY = 'x'.repeat(32);

describe('deriveKey', () => {
  it('derives distinct 32-byte keys per purpose, deterministically', () => {
    const jwt = deriveKey(ENCRYPTION_KEY, 'auth-jwt');
    const data = deriveKey(ENCRYPTION_KEY, 'data-encryption');
    expect(jwt).toHaveLength(32);
    expect(data).toHaveLength(32);
    expect(jwt.equals(data)).toBe(false);
    expect(deriveKey(ENCRYPTION_KEY, 'auth-jwt').equals(jwt)).toBe(true);
  });

  it('depends on the encryption key', () => {
    expect(deriveKey('y'.repeat(32), 'auth-jwt').equals(deriveKey(ENCRYPTION_KEY, 'auth-jwt'))).toBe(false);
  });
});

describe('createCipher', () => {
  const cipher = createCipher(deriveKey(ENCRYPTION_KEY, 'data-encryption'));

  it('round-trips text in the v1 format', () => {
    const payload = cipher.encrypt('tajne');
    expect(payload).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(cipher.decrypt(payload)).toBe('tajne');
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
    expect(cipher.decrypt(cipher.encrypt('zażółć 🔑'))).toBe('zażółć 🔑');
  });

  it('uses a random IV, so equal plaintexts encrypt differently', () => {
    expect(cipher.encrypt('tajne')).not.toBe(cipher.encrypt('tajne'));
  });

  it('rejects tampered data', () => {
    const [v, iv, tag, data] = cipher.encrypt('tajne').split(':') as [string, string, string, string];
    const flipped = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
    expect(() => cipher.decrypt([v, iv, tag, flipped].join(':'))).toThrow(new Error('Decryption failed'));
  });

  it('rejects a tampered tag or IV', () => {
    const [v, iv, tag, data] = cipher.encrypt('tajne').split(':') as [string, string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => cipher.decrypt([v, iv, flip(tag), data].join(':'))).toThrow(new Error('Decryption failed'));
    expect(() => cipher.decrypt([v, flip(iv), tag, data].join(':'))).toThrow(new Error('Decryption failed'));
  });

  it('rejects a different key', () => {
    const other = createCipher(deriveKey('y'.repeat(32), 'data-encryption'));
    expect(() => other.decrypt(cipher.encrypt('tajne'))).toThrow(new Error('Decryption failed'));
  });

  it('rejects malformed payloads without leaking the cause', () => {
    for (const bad of ['', 'garbage', 'v2:a:b:c', 'v1:a:b', 'v1:::', 'v1:AAAA:AAAA:AAAA:AAAA']) {
      expect(() => cipher.decrypt(bad)).toThrow(new Error('Decryption failed'));
    }
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => createCipher(Buffer.alloc(16))).toThrow();
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('Haslo123');
    expect(hash).not.toContain('Haslo123');
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword('Haslo123', hash)).toBe(true);
    expect(await verifyPassword('haslo123', hash)).toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('Haslo123', 'not-a-hash')).toBe(false);
  });
});

describe('validatePasswordPolicy', () => {
  it('uses the message from the global constraints', () => {
    expect(PASSWORD_POLICY_MESSAGE).toBe(
      'Password must be 8–64 characters and contain a number and an uppercase letter',
    );
  });

  it.each([['Short1A'], ['nouppercase1'], ['NoDigitsHere'], [`${'A'.repeat(64)}1`]])(
    'rejects %s',
    (plain) => {
      expect(validatePasswordPolicy(plain)).toBe(PASSWORD_POLICY_MESSAGE);
    },
  );

  it('accepts valid passwords at both length limits', () => {
    expect(validatePasswordPolicy('Haslo123')).toBeNull();
    expect(validatePasswordPolicy(`${'A'.repeat(63)}1`)).toBeNull();
  });

  it('counts characters, not UTF-16 code units', () => {
    // 8 emoji (2 code units each) + "A1" = 10 characters, 34 bytes.
    expect(validatePasswordPolicy(`${'🔑'.repeat(8)}A1`)).toBeNull();
    expect(validatePasswordPolicy('🔑🔑🔑🔑🔑A1')).toBe(PASSWORD_POLICY_MESSAGE); // 7 characters
  });

  it('rejects passwords over 72 UTF-8 bytes (bcrypt ignores the rest)', () => {
    // 38 characters but 74 bytes: "ł" is 2 bytes in UTF-8.
    expect(validatePasswordPolicy(`${'ł'.repeat(36)}A1`)).toBe(PASSWORD_POLICY_MESSAGE);
    // 72 bytes exactly is fine.
    expect(validatePasswordPolicy(`${'ł'.repeat(35)}A1`)).toBeNull();
    // 18 emoji × 4 bytes + "A1" = 74 bytes.
    expect(validatePasswordPolicy(`${'🔑'.repeat(18)}A1`)).toBe(PASSWORD_POLICY_MESSAGE);
  });
});

describe('sha256 and randomToken', () => {
  it('hashes to lowercase hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('produces random base64url tokens of the requested entropy', () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(a);
  });
});
