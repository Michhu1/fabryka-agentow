import { randomInt } from 'node:crypto';
import type { AppConfig } from '@app/config';
import { MFA_REQUIRED_CODE, type MfaSetup } from '@app/shared';
import type { Redis } from 'ioredis';
import { Secret, TOTP } from 'otpauth';
import type { DataSource } from 'typeorm';
import { createCipher } from '../crypto/cipher.js';
import { deriveKey } from '../crypto/keys.js';
import { sha256 } from '../crypto/password.js';
import { User } from '../db/entities/user.entity.js';
import { HttpError } from '../http/errors.js';
import { secondFactorAttemptLimiter } from './rate-limit.js';

/** A second factor as sent by the client: a TOTP code from the authenticator app or a recovery code. */
export type MfaInput = { code?: string; recoveryCode?: string };

export type MfaService = {
  /**
   * Generates a new secret and new recovery codes (replacing unconfirmed ones); 2FA stays off until
   * `enable` proves the authenticator app works. 400 when 2FA is already on.
   */
  setup(user: User): Promise<MfaSetup>;
  /** Turns 2FA on with a TOTP code for the secret from `setup`; 400 for a wrong code or without setup. */
  enable(user: User, code: string): Promise<void>;
  /** Turns 2FA off with a TOTP or recovery code and forgets the secret and codes. */
  disable(user: User, mfa: MfaInput): Promise<void>;
  /**
   * Checks a TOTP code, or consumes a recovery code, of `user`. Every failure counts towards the per-user
   * limit; over it → 429 without checking.
   */
  verifySecondFactor(user: User, mfa: MfaInput): Promise<boolean>;
};

export const MFA_ISSUER = 'moj-n8n';
const SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const INVALID_CODE = 'Invalid two-factor code';
const ALREADY_ENABLED = 'Two-factor authentication is already enabled';

/** The TOTP parameters every authenticator app supports (and n8n uses): SHA1, 6 digits, 30 s. */
function totpFor(secret: string, email: string): TOTP {
  return new TOTP({
    issuer: MFA_ISSUER,
    label: email,
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
}

/** `xxxx-xxxx-xxxx` of lowercase letters and digits; `randomInt` is uniform (no modulo bias), ~62 bits. */
export function generateRecoveryCode(): string {
  const chars = Array.from({ length: 12 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((group) => group.join('')).join('-');
}

/**
 * Recovery codes are compared by the hash of their normalized form: lowercase letters and digits only,
 * so a code typed in capitals, without its dashes or with spaces instead (`ABCD 1234 EFGH`) still counts.
 * Used both when the codes are stored and when one is checked.
 */
function recoveryCodeHash(code: string): string {
  return sha256(code.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function createMfaService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  redis?: Redis;
}): MfaService {
  const { dataSource } = deps;
  const cipher = createCipher(deriveKey(deps.config.encryptionKey, 'data-encryption'));
  const attempts = secondFactorAttemptLimiter(deps.redis);
  const users = () => dataSource.getRepository(User);

  const encryptCodes = (codes: string[]) => cipher.encrypt(JSON.stringify(codes.map(recoveryCodeHash)));

  function totpValid(encryptedSecret: string, email: string, code: string): boolean {
    const token = code.trim();
    if (!/^\d{6}$/.test(token)) return false;
    // Window 1: the previous and next 30-second codes are accepted too (clock drift, typing time).
    return totpFor(cipher.decrypt(encryptedSecret), email).validate({ token, window: 1 }) !== null;
  }

  /**
   * Removes the code's hash under a row lock, so of two concurrent logins with one recovery code exactly
   * one succeeds. (Comparing hex SHA-256 hashes with `===` leaks nothing useful about the stored codes.)
   */
  async function consumeRecoveryCode(user: User, code: string): Promise<boolean> {
    const hash = recoveryCodeHash(code);
    return dataSource.transaction(async (em) => {
      const rows: { mfa_recovery_codes: string | null }[] = await em.query(
        `SELECT mfa_recovery_codes FROM "user" WHERE id = $1 FOR UPDATE`,
        [user.id],
      );
      const stored = rows[0]?.mfa_recovery_codes;
      if (!stored) return false;
      const hashes = JSON.parse(cipher.decrypt(stored)) as string[];
      const remaining = hashes.filter((h) => h !== hash);
      if (remaining.length === hashes.length) return false;
      const encrypted = cipher.encrypt(JSON.stringify(remaining));
      await em.update(User, { id: user.id }, { mfaRecoveryCodes: encrypted });
      user.mfaRecoveryCodes = encrypted;
      return true;
    });
  }

  /** Runs one second-factor check under the per-user attempt limit (only failures are counted). */
  async function limited(user: User, check: () => Promise<boolean> | boolean): Promise<boolean> {
    if (!(await attempts.take(user.id))) throw new HttpError(429, 'Too many requests');
    const ok = await check();
    if (ok) await attempts.refund(user.id);
    return ok;
  }

  async function verifySecondFactor(user: User, mfa: MfaInput): Promise<boolean> {
    const secret = user.mfaSecret;
    // Nothing to guess without a secret, so such a call is not counted as an attempt.
    if (!secret || (!mfa.code && !mfa.recoveryCode)) return false;
    return limited(user, () =>
      mfa.code ? totpValid(secret, user.email, mfa.code) : consumeRecoveryCode(user, mfa.recoveryCode ?? ''),
    );
  }

  return {
    async setup(user) {
      if (user.mfaEnabled) throw new HttpError(400, ALREADY_ENABLED);
      const secret = new Secret({ size: SECRET_BYTES }).base32;
      const codes = new Set<string>();
      while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateRecoveryCode());
      const recoveryCodes = [...codes];
      const mfaSecret = cipher.encrypt(secret);
      const mfaRecoveryCodes = encryptCodes(recoveryCodes);
      // Conditional on 2FA still being off: a concurrent `enable` must not get its secret swapped.
      const result = await users().update(
        { id: user.id, mfaEnabled: false },
        { mfaSecret, mfaRecoveryCodes },
      );
      if (result.affected !== 1) throw new HttpError(400, ALREADY_ENABLED);
      Object.assign(user, { mfaSecret, mfaRecoveryCodes });
      return { secret, otpauthUrl: totpFor(secret, user.email).toString(), recoveryCodes };
    },

    async enable(user, code) {
      if (user.mfaEnabled) throw new HttpError(400, ALREADY_ENABLED);
      const secret = user.mfaSecret;
      if (!secret) throw new HttpError(400, 'Set up two-factor authentication first');
      // Only a TOTP code: enabling must prove that the authenticator app has the secret.
      if (!(await limited(user, () => totpValid(secret, user.email, code)))) {
        throw new HttpError(400, INVALID_CODE);
      }
      // Only the secret the code was checked against gets enabled (a concurrent setup may have replaced it).
      const result = await users().update(
        { id: user.id, mfaEnabled: false, mfaSecret: secret },
        { mfaEnabled: true },
      );
      if (result.affected !== 1) throw new HttpError(400, INVALID_CODE);
      user.mfaEnabled = true;
    },

    async disable(user, mfa) {
      if (!user.mfaEnabled) throw new HttpError(400, 'Two-factor authentication is not enabled');
      if (!mfa.code && !mfa.recoveryCode) throw new HttpError(400, 'MFA required', MFA_REQUIRED_CODE);
      if (!(await verifySecondFactor(user, mfa))) throw new HttpError(400, INVALID_CODE);
      await users().update({ id: user.id }, { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: null });
      Object.assign(user, { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: null });
    },

    verifySecondFactor,
  };
}
