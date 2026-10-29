import { Secret, TOTP } from 'otpauth';

const PERIOD_SECONDS = 30;
/** A code this close to the end of its 30 s window could expire on the way: wait for the next one. */
const SAFETY_SECONDS = 5;

/**
 * The current 6-digit code for a 2FA secret, like an authenticator app shows it (SHA1, 6 digits, 30 s —
 * the server's settings). Waits for a fresh window near the boundary, because wrong codes count towards
 * the per-user limit of failed attempts.
 */
export async function totpCode(secret: string): Promise<string> {
  const left = PERIOD_SECONDS - (Math.floor(Date.now() / 1000) % PERIOD_SECONDS);
  if (left <= SAFETY_SECONDS) await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000));
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
  }).generate();
}
