import type { AppConfig } from '@app/config';
import { MFA_REQUIRED_CODE } from '@app/shared';
import jwt from 'jsonwebtoken';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { hashPassword, sha256 } from '../crypto/password.js';
import { User } from '../db/entities/user.entity.js';
import { describeError } from '../describe-error.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import type { Mailer } from '../mail/mailer.js';
import { passwordResetEmail } from '../mail/templates.js';
import { type AuthService, emailField, newPasswordField } from './auth-service.js';
import { jwtKey, UUID } from './session.js';

const RESET_TTL_SECONDS = 20 * 60;
const INVALID_TOKEN = 'Invalid password reset token';

const forgotSchema = strictBody({ email: emailField });

const changeSchema = strictBody({
  token: z.string({ error: INVALID_TOKEN }).max(2048, { error: INVALID_TOKEN }),
  password: newPasswordField,
  mfaCode: z.string().max(64).optional(),
});

/**
 * Fingerprint of the current email and password inside a reset token: setting a new password changes
 * it, so a used link stops working without storing anything. The email is included (the plan had only
 * the password hash) so that a link mailed to an address the account no longer uses stops working
 * once the email is changed — that mailbox may no longer belong to the user.
 */
export function passwordFingerprint(user: Pick<User, 'email'> & { passwordHash: string }): string {
  return sha256(`${user.email}:${user.passwordHash}`).slice(0, 10);
}

export type PasswordResetService = {
  /** Mails a reset link when an active account with a password has this email; does nothing otherwise. */
  requestReset(input: unknown): Promise<void>;
  /** The user a reset token belongs to; 400 `Invalid password reset token` for anything else. */
  resolveToken(token: unknown): Promise<User>;
  /** Sets the new password (2FA code required when 2FA is on) and returns the updated user. */
  changePassword(input: unknown): Promise<User>;
};

export function createPasswordResetService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  mailer: Mailer;
  auth: AuthService;
}): PasswordResetService {
  const { dataSource, config, mailer, auth } = deps;
  const users = () => dataSource.getRepository(User);

  function createToken(user: User, passwordHash: string): string {
    const ph = passwordFingerprint({ email: user.email, passwordHash });
    return jwt.sign({ sub: user.id, ph }, jwtKey(config), {
      algorithm: 'HS256',
      expiresIn: RESET_TTL_SECONDS,
    });
  }

  /** Signature, expiry and the exact reset-token shape; null for anything else. */
  function readToken(token: unknown): { sub: string; ph: string } | null {
    if (typeof token !== 'string' || token === '' || token.length > 2048) return null;
    try {
      const payload = jwt.verify(token, jwtKey(config), { algorithms: ['HS256'] });
      if (typeof payload !== 'object' || payload === null) return null;
      const { sub, ph, exp } = payload as Record<string, unknown>;
      if (typeof sub !== 'string' || !UUID.test(sub) || typeof ph !== 'string' || typeof exp !== 'number')
        return null;
      // Session and invitation tokens are signed with the same key: refuse anything carrying their claims.
      if ('h' in payload || 'jti' in payload || 'inv' in payload) return null;
      return { sub, ph };
    } catch {
      return null;
    }
  }

  /** The user and the password hash the token was issued for. */
  async function resolve(token: unknown): Promise<{ user: User; passwordHash: string }> {
    const payload = readToken(token);
    if (!payload) throw new HttpError(400, INVALID_TOKEN);
    const user = await users().findOneBy({ id: payload.sub });
    const passwordHash = user?.passwordHash;
    if (
      !user ||
      user.disabled ||
      !passwordHash ||
      passwordFingerprint({ email: user.email, passwordHash }) !== payload.ph
    ) {
      throw new HttpError(400, INVALID_TOKEN);
    }
    return { user, passwordHash };
  }

  return {
    async requestReset(raw) {
      const { email } = validate(forgotSchema, raw);
      const user = await users().findOneBy({ email });
      // Invited users (no password yet) use their invitation link instead, as in n8n.
      if (!user || user.disabled || !user.passwordHash) return;
      const link = `${config.editorBaseUrl}/reset-password?token=${createToken(user, user.passwordHash)}`;
      // Not awaited: the answer is the same 200 whether or not the account exists, and it should not
      // take noticeably longer (or hang on a slow SMTP server) when it does. The log line carries
      // neither the link nor the email address.
      mailer.send({ to: user.email, ...passwordResetEmail(link) }).catch((error: unknown) => {
        console.error(`Password reset email for user ${user.id} could not be sent (${describeError(error)})`);
      });
    },

    async resolveToken(token) {
      return (await resolve(token)).user;
    },

    async changePassword(raw) {
      const input = validate(changeSchema, raw);
      const { user, passwordHash: oldHash } = await resolve(input.token);
      if (user.mfaEnabled) {
        if (!input.mfaCode) throw new HttpError(400, 'MFA required', MFA_REQUIRED_CODE);
        if (!(await auth.verifySecondFactor(user, { code: input.mfaCode }))) {
          throw new HttpError(400, 'Invalid two-factor code');
        }
      }
      // bcrypt first, no transaction needed: the update below only applies while the password (and the
      // email) are still the ones the token was issued for, so of two concurrent uses of one link exactly
      // one wins, and an email change meanwhile also wins over the link.
      const passwordHash = await hashPassword(input.password);
      const result = await users().update(
        { id: user.id, email: user.email, passwordHash: oldHash, disabled: false },
        { passwordHash },
      );
      if (result.affected !== 1) throw new HttpError(400, INVALID_TOKEN);
      // Every older session dies with it: their `h` was computed from the old password hash.
      user.passwordHash = passwordHash;
      return user;
    },
  };
}
