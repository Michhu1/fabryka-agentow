import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_COST = 10;
const BCRYPT_MAX_BYTES = 72;

export const PASSWORD_POLICY_MESSAGE =
  'Password must be 8–64 characters and contain a number and an uppercase letter';

/** bcryptjs is pure JS, so the server builds on Windows without native compilation. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** A malformed stored hash counts as a mismatch rather than an error. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Same rule as n8n: 8–64 characters (code points, so emoji count once), at least one digit (0-9) and one
 * uppercase letter (any script, e.g. Polish "Ł"), plus at most 72 UTF-8 bytes (bcrypt's limit).
 * Returns the error message, or null when valid.
 */
export function validatePasswordPolicy(plain: string): string | null {
  const length = [...plain].length;
  const valid =
    length >= 8 &&
    length <= 64 &&
    // bcrypt only uses the first 72 bytes: two longer passwords sharing those bytes would both match.
    // 64 non-ASCII characters (e.g. "ł" = 2 bytes, emoji = 4) can exceed that, so cap the bytes too.
    Buffer.byteLength(plain, 'utf8') <= BCRYPT_MAX_BYTES &&
    /\d/.test(plain) &&
    /\p{Lu}/u.test(plain);
  return valid ? null : PASSWORD_POLICY_MESSAGE;
}

/** Lowercase hex SHA-256, used to store tokens so a database leak does not reveal them. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}
