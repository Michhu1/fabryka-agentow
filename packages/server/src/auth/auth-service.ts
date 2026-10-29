import type { AppConfig } from '@app/config';
import { MFA_REQUIRED_CODE, type PublicUser } from '@app/shared';
import type { Redis } from 'ioredis';
import type { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import {
  hashPassword,
  PASSWORD_POLICY_MESSAGE,
  validatePasswordPolicy,
  verifyPassword,
} from '../crypto/password.js';
import { Project } from '../db/entities/project.entity.js';
import { ProjectRelation } from '../db/entities/project-relation.entity.js';
import { User } from '../db/entities/user.entity.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import { projectBlockedSql } from '../projects/project-access.js';
import { readLinkToken, transferSenderIsOwnerSql } from '../projects/project-links.js';
import { effectiveTeamProjectsLimit, ownedTeamProjectCount } from '../projects/team-project-limit.js';
import type { MfaInput, MfaService } from './mfa-service.js';
import { createAttemptLimiter } from './rate-limit.js';

export type { MfaInput } from './mfa-service.js';

/** Email as stored and looked up everywhere. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Input fields shared by signup, invitations and the profile page. */
export const emailField = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Invalid email address' }).max(254, { error: 'Invalid email address' }));

const nameField = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} is required` })
    .max(32, { error: `${label} must be at most 32 characters` });
export const firstNameField = nameField('First name');
export const lastNameField = nameField('Last name');

/** A new password: the n8n policy (8–64 characters, a digit and an uppercase letter). */
export const newPasswordField = z
  .string({ error: PASSWORD_POLICY_MESSAGE })
  .refine((value) => validatePasswordPolicy(value) === null, { error: PASSWORD_POLICY_MESSAGE });

/**
 * A 401 that is not about the session: the client must show it on the form instead of signing out
 * (a stale session answers `Unauthorized`).
 */
export const WRONG_CURRENT_PASSWORD = 'Current password is incorrect';
export const CURRENT_PASSWORD_REQUIRED = 'Current password is required';

/** The current password, asked again before sensitive changes (email, password, project transfer). */
export const currentPasswordField = z
  .string({ error: CURRENT_PASSWORD_REQUIRED })
  .min(1, { error: CURRENT_PASSWORD_REQUIRED })
  .max(1024, { error: WRONG_CURRENT_PASSWORD });

const INVALID_INVITE_TOKEN = 'Invalid invite token';

const signupSchema = strictBody({
  email: emailField,
  firstName: firstNameField,
  lastName: lastNameField,
  password: newPasswordField,
  /**
   * The token of a project invitation or transfer link mailed to `email`: lets that address sign up
   * while `SIGNUP_ENABLED=false` (owner decision). Ignored when signup is open.
   */
  inviteToken: z.string({ error: INVALID_INVITE_TOKEN }).max(256, { error: INVALID_INVITE_TOKEN }).optional(),
});

/**
 * Whether `token` is a pending (not expired) project invitation or transfer for `email`, in a project
 * that is not blocked — what the link's page itself would resolve. Signing up does not use it up.
 */
async function linkAllowsSignup(
  em: EntityManager,
  token: string | undefined,
  email: string,
): Promise<boolean> {
  const tokenHash = readLinkToken(token);
  if (!tokenHash) return false;
  const now = new Date(); // in Node, not SQL `now()`, so tests can move the clock
  const rows: unknown[] = await em.query(
    `SELECT 1 FROM project_invitation i
     WHERE i.token_hash = $1 AND i.email = $2 AND i.expires_at > $3 AND NOT ${projectBlockedSql('i.project_id')}
     UNION ALL
     SELECT 1 FROM project_transfer t
     WHERE t.token_hash = $1 AND t.to_email = $2 AND t.expires_at > $3 AND NOT ${projectBlockedSql('t.project_id')}
       AND ${transferSenderIsOwnerSql('t')}
     LIMIT 1`,
    [tokenHash, email, now],
  );
  return rows.length > 0;
}

/** n8n's name for a personal project: `Jan Kowalski <jan@firma.pl>` (capped to the column length). */
export function personalProjectName(user: Pick<User, 'firstName' | 'lastName' | 'email'>): string {
  return `${user.firstName} ${user.lastName} <${user.email}>`.slice(0, 255);
}

/**
 * A valid bcrypt hash (cost 10) of a random string nobody knows: unknown emails are checked against it
 * so that the response time does not reveal whether an account exists.
 */
export const DUMMY_PASSWORD_HASH = '$2b$10$biiI5zSx/lD2tCKLRvXfUeaK/g1Ij9zz/rwCWozY1xk.AJglrYohy';

const WRONG_CREDENTIALS = 'Wrong username or password';

export type AuthService = {
  signup(input: {
    email: unknown;
    firstName: unknown;
    lastName: unknown;
    password: unknown;
    inviteToken?: unknown;
  }): Promise<User>;
  login(email: string, password: string, mfa?: MfaInput): Promise<User>;
  /**
   * Checks a TOTP or recovery code of a user with 2FA on. The single place every flow (login, password
   * reset, password change) verifies a second factor.
   */
  verifySecondFactor(user: User, mfa: MfaInput): Promise<boolean>;
  /**
   * Re-confirms a signed-in user's password before a sensitive change: 401 `Current password is
   * incorrect` unless it matches, 429 after 10 wrong ones within a minute (per user, counted across every
   * route that asks for it). Returns the verified hash.
   */
  verifyCurrentPassword(user: User, password: string): Promise<string>;
  /**
   * Re-confirms the second factor of a signed-in user with 2FA on (no-op otherwise): 400 `MFA required`
   * (code 998) without a code, 400 `Invalid two-factor code` for a wrong one.
   */
  verifyCurrentSecondFactor(user: User, mfaCode: string | undefined): Promise<void>;
  toPublicUser(user: User): Promise<PublicUser>;
};

export function createAuthService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  mfa: MfaService;
  redis?: Redis;
}): AuthService {
  const { dataSource, config, mfa: mfaService } = deps;
  // A stolen session alone must not be enough to guess the password (which unlocks email and password
  // changes and project transfers): 10 wrong current passwords per minute per user, all routes together.
  const currentPasswordAttempts = createAttemptLimiter({
    name: 'current-password-user',
    windowMs: 60_000,
    limit: 10,
    redis: deps.redis,
  });

  /** Runs under the signup lock: keep it to a few short queries (the password is hashed beforehand). */
  async function createAccount(
    em: EntityManager,
    input: z.output<typeof signupSchema>,
    passwordHash: string,
  ): Promise<User> {
    const rows: { exists: boolean }[] = await em.query(`SELECT EXISTS (SELECT 1 FROM "user") AS "exists"`);
    const hasUsers = rows[0]?.exists === true;
    if (!config.signupEnabled && hasUsers && !(await linkAllowsSignup(em, input.inviteToken, input.email))) {
      throw new HttpError(403, 'Signup is disabled');
    }
    if (await em.existsBy(User, { email: input.email })) throw new HttpError(400, 'Email already in use');

    const user = await em.save(
      em.create(User, {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        passwordHash,
        // Checking for any user (not for an owner) means a later signup can never take over an
        // instance that has no owner.
        role: hasUsers ? 'global:member' : 'global:owner',
      }),
    );
    const project = await em.save(
      em.create(Project, { name: personalProjectName(user), type: 'personal', creatorId: user.id }),
    );
    await em.save(
      em.create(ProjectRelation, { projectId: project.id, userId: user.id, role: 'project:personalOwner' }),
    );
    return user;
  }

  function verifySecondFactor(user: User, mfa: MfaInput): Promise<boolean> {
    return mfaService.verifySecondFactor(user, mfa);
  }

  /** Two-factor check at login for users with 2FA on. */
  async function checkMfa(user: User, mfa: MfaInput | undefined): Promise<void> {
    if (!mfa?.code && !mfa?.recoveryCode) throw new HttpError(401, 'MFA required', MFA_REQUIRED_CODE);
    if (!(await verifySecondFactor(user, mfa))) throw new HttpError(401, 'Invalid two-factor code');
  }

  return {
    async signup(raw) {
      const input = validate(signupSchema, raw);
      // bcrypt (~50–100 ms) outside the transaction: no pool connection or lock is held meanwhile.
      const passwordHash = await hashPassword(input.password);
      try {
        // The advisory lock serializes signups, so exactly one of several concurrent first signups
        // becomes the owner and the email check below cannot race.
        return await dataSource.transaction(async (em) => {
          await em.query(`SELECT pg_advisory_xact_lock(hashtext('signup'))`);
          return createAccount(em, input, passwordHash);
        });
      } catch (error) {
        // Safety net: the unique index wins any race the lock does not cover (e.g. an invitation).
        if ((error as { code?: unknown }).code === '23505') throw new HttpError(400, 'Email already in use');
        throw error;
      }
    },

    async login(email, password, mfa) {
      const user = await dataSource.getRepository(User).findOneBy({ email: normalizeEmail(email) });
      const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user?.passwordHash || !valid || user.disabled) throw new HttpError(401, WRONG_CREDENTIALS);
      if (user.mfaEnabled) await checkMfa(user, mfa);
      return user;
    },

    verifySecondFactor,

    async verifyCurrentPassword(user, password) {
      const passwordHash = user.passwordHash;
      if (!passwordHash) throw new HttpError(401, 'Unauthorized'); // `authenticate` already refuses this
      if (!(await currentPasswordAttempts.take(user.id))) throw new HttpError(429, 'Too many requests');
      if (!(await verifyPassword(password, passwordHash))) throw new HttpError(401, WRONG_CURRENT_PASSWORD);
      await currentPasswordAttempts.refund(user.id);
      return passwordHash;
    },

    async verifyCurrentSecondFactor(user, mfaCode) {
      if (!user.mfaEnabled) return;
      if (!mfaCode) throw new HttpError(400, 'MFA required', MFA_REQUIRED_CODE);
      if (!(await verifySecondFactor(user, { code: mfaCode }))) {
        throw new HttpError(400, 'Invalid two-factor code');
      }
    },

    async toPublicUser(user) {
      const relation = await dataSource
        .getRepository(ProjectRelation)
        .findOneBy({ userId: user.id, role: 'project:personalOwner' });
      if (!relation) throw new Error(`User ${user.id} has no personal project`);
      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        mfaEnabled: user.mfaEnabled,
        settings: { theme: user.settings?.theme ?? 'system' },
        personalProjectId: relation.projectId,
        teamProjectsLimit: effectiveTeamProjectsLimit(user, config),
        ownedTeamProjects: await ownedTeamProjectCount(dataSource.manager, user.id),
      };
    },
  };
}
