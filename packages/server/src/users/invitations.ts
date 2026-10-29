import type { AppConfig } from '@app/config';
import type { InvitationInfo, InvitationResult } from '@app/shared';
import jwt from 'jsonwebtoken';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import {
  emailField,
  firstNameField,
  lastNameField,
  newPasswordField,
  personalProjectName,
} from '../auth/auth-service.js';
import { jwtKey, UUID } from '../auth/session.js';
import { hashPassword } from '../crypto/password.js';
import { Project } from '../db/entities/project.entity.js';
import { ProjectRelation } from '../db/entities/project-relation.entity.js';
import { User } from '../db/entities/user.entity.js';
import { describeError } from '../describe-error.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import type { Mailer } from '../mail/mailer.js';
import { invitationEmail } from '../mail/templates.js';

const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const INVALID_TOKEN = 'Invalid invitation token';

const inviteSchema = strictBody({
  emails: z
    .array(emailField, { error: 'Emails must be a list' })
    .min(1, { error: 'At least one email is required' })
    .max(20, { error: 'At most 20 emails at once' }),
  role: z.enum(['global:member', 'global:admin'], { error: 'Role must be global:member or global:admin' }),
});

const tokenField = z.string({ error: INVALID_TOKEN }).max(2048, { error: INVALID_TOKEN });

const acceptSchema = strictBody({
  token: tokenField,
  firstName: firstNameField,
  lastName: lastNameField,
  password: newPasswordField,
});

/** Claims of an invitation token: the invited account, and who invited it (for "X invites you"). */
type InvitationClaims = { sub: string; by: string };

export type InvitationService = {
  /**
   * Creates accounts without a password for new addresses and mails each one a link. An address with
   * an account is `exists` — unless that account is still pending, in which case the link is sent
   * again (n8n's "resend invite"); its role stays as first invited.
   */
  invite(inviter: User, input: unknown): Promise<InvitationResult[]>;
  /** The invited address and the inviter's name; 400 `Invalid invitation token` for anything else. */
  resolve(token: unknown): Promise<InvitationInfo>;
  /** Sets name and password and creates the personal project; returns the now active user. */
  accept(input: unknown): Promise<User>;
};

/** Invitations to the instance (n8n: `/rest/invitations`). A pending account is one without a password. */
export function createInvitationService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  mailer: Mailer;
}): InvitationService {
  const { dataSource, config, mailer } = deps;
  const users = () => dataSource.getRepository(User);

  function createToken(userId: string, inviterId: string): string {
    return jwt.sign({ sub: userId, inv: true, by: inviterId }, jwtKey(config), {
      algorithm: 'HS256',
      expiresIn: INVITATION_TTL_SECONDS,
    });
  }

  /** Signature, expiry and the exact invitation shape; null for anything else. */
  function readToken(token: unknown): InvitationClaims | null {
    if (typeof token !== 'string' || token === '' || token.length > 2048) return null;
    try {
      const payload = jwt.verify(token, jwtKey(config), { algorithms: ['HS256'] });
      if (typeof payload !== 'object' || payload === null) return null;
      const { sub, inv, by, exp } = payload as Record<string, unknown>;
      if (typeof sub !== 'string' || !UUID.test(sub) || inv !== true || typeof exp !== 'number') return null;
      if (typeof by !== 'string' || !UUID.test(by)) return null;
      // Session and reset tokens are signed with the same key: refuse anything carrying their claims.
      if ('h' in payload || 'jti' in payload || 'ph' in payload) return null;
      return { sub, by };
    } catch {
      return null;
    }
  }

  /** The pending, enabled account a token is for. A set password means the invitation was used. */
  async function pendingUser(token: unknown): Promise<{ user: User; claims: InvitationClaims }> {
    const claims = readToken(token);
    if (!claims) throw new HttpError(400, INVALID_TOKEN);
    const user = await users().findOneBy({ id: claims.sub });
    if (!user || user.passwordHash !== null || user.disabled) throw new HttpError(400, INVALID_TOKEN);
    return { user, claims };
  }

  /**
   * Mails one invitation. A failure is logged — with the user id only, never the link or the address —
   * and does not fail the request: the account exists, and inviting it again re-sends the link.
   */
  async function sendInvitation(user: Pick<User, 'id' | 'email'>, inviter: User): Promise<void> {
    const link = `${config.editorBaseUrl}/accept-invite?token=${createToken(user.id, inviter.id)}`;
    try {
      await mailer.send({ to: user.email, ...invitationEmail(link, displayName(inviter)) });
    } catch (error) {
      console.error(`Invitation email for user ${user.id} could not be sent (${describeError(error)})`);
    }
  }

  return {
    async invite(inviter, raw) {
      const input = validate(inviteSchema, raw);
      // Only the owner hands out admin rights (same as n8n).
      if (input.role === 'global:admin' && inviter.role !== 'global:owner') {
        throw new HttpError(403, 'Forbidden');
      }
      const emails = [...new Set(input.emails)];
      // One statement: an address taken meanwhile (signup, another invitation) is simply not inserted.
      const created: { id: string; email: string }[] = await dataSource.query(
        `INSERT INTO "user" (email, first_name, last_name, role)
         SELECT email, '', '', $2 FROM unnest($1::varchar[]) AS email
         ON CONFLICT (email) DO NOTHING
         RETURNING id, email`,
        [emails, input.role],
      );
      const createdIds = new Map(created.map((row) => [row.email, row.id]));
      const existing = await users()
        .createQueryBuilder('u')
        .where('u.email IN (:...emails)', { emails })
        .andWhere('u.password_hash IS NULL AND NOT u.disabled')
        .getMany();
      const pending = new Map(existing.map((user) => [user.email, user.id]));

      const toMail: { id: string; email: string }[] = [];
      const results = emails.map((email): InvitationResult => {
        const id = createdIds.get(email) ?? pending.get(email);
        if (id === undefined) return { email, status: 'exists' };
        toMail.push({ id, email });
        return { email, status: 'invited' };
      });
      await Promise.all(toMail.map((user) => sendInvitation(user, inviter)));
      return results;
    },

    async resolve(token) {
      const { user, claims } = await pendingUser(token);
      const inviter = await users().findOneBy({ id: claims.by });
      return { email: user.email, inviterName: inviter ? displayName(inviter) : null };
    },

    async accept(raw) {
      const input = validate(acceptSchema, raw);
      // Checked before bcrypt, so used or forged tokens cost no hashing.
      const { user } = await pendingUser(input.token);
      const passwordHash = await hashPassword(input.password);
      return dataSource.transaction(async (em) => {
        // Row lock: of two concurrent accepts the second waits here and then finds the password set.
        const fresh = await em.findOne(User, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } });
        if (!fresh || fresh.passwordHash !== null || fresh.disabled) throw new HttpError(400, INVALID_TOKEN);
        const changes = { firstName: input.firstName, lastName: input.lastName, passwordHash };
        await em.update(User, { id: fresh.id }, changes);
        Object.assign(fresh, changes);
        const project = await em.save(
          em.create(Project, { name: personalProjectName(fresh), type: 'personal', creatorId: fresh.id }),
        );
        await em.insert(ProjectRelation, {
          projectId: project.id,
          userId: fresh.id,
          role: 'project:personalOwner',
        });
        return fresh;
      });
    },
  };
}

function displayName(user: Pick<User, 'firstName' | 'lastName'>): string {
  return `${user.firstName} ${user.lastName}`.trim();
}
