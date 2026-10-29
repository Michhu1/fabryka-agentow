import type { AppConfig } from '@app/config';
import type {
  MemberRole,
  ProjectInvitation,
  ProjectInvitationInfo,
  ProjectInvitationResult,
  ProjectSummary,
} from '@app/shared';
import type { DataSource } from 'typeorm';
import { emailField } from '../auth/auth-service.js';
import { UUID } from '../auth/session.js';
import { randomToken, sha256 } from '../crypto/password.js';
import type { User } from '../db/entities/user.entity.js';
import { describeError } from '../describe-error.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import type { Mailer } from '../mail/mailer.js';
import { projectInvitationEmail } from '../mail/templates.js';
import { assertRole, isProjectBlocked, type ProjectAccess, projectBlockedSql } from './project-access.js';
import { displayName, linkAccountColumnsSql, linkTokenField, readLinkToken } from './project-links.js';
import { lockProjectMembers, withLockedMembers, withLockedProject } from './project-lock.js';
import { memberRoleField, projectSummary } from './project-service.js';

/** How long an invitation link works. */
export const PROJECT_INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

const INVALID_TOKEN = 'Invalid invitation token';
const INVITATION_NOT_FOUND = 'Invitation not found';
const WRONG_EMAIL = 'This invitation is for a different email address';
const ALREADY_MEMBER = 'User is already a member';

const inviteSchema = strictBody({ email: emailField, role: memberRoleField });
const acceptSchema = strictBody({ token: linkTokenField(INVALID_TOKEN) });

export type ProjectInvitationService = {
  /** Always the same answer and always a mail, whether or not the address has an account. */
  invite(actor: User, projectId: string, input: unknown): Promise<ProjectInvitationResult>;
  /** Pending (not expired) invitations of the project, oldest first; owner only. */
  list(actorId: string, projectId: string): Promise<ProjectInvitation[]>;
  cancel(actorId: string, projectId: string, invitationId: string): Promise<void>;
  /** What the link is for; 400 `Invalid invitation token` for anything else. Public. */
  resolve(token: unknown): Promise<ProjectInvitationInfo>;
  /** Makes the signed-in user (whose email must be the invited one) a member; one time only. */
  accept(user: User, input: unknown): Promise<ProjectSummary>;
};

/**
 * Invitations to team projects (replacing n8n's direct "add member"): the owner invites an email
 * address, the invited person accepts through a one-time link valid for 7 days. Nobody becomes a member
 * without their consent, and the owner never learns whether an address has an account: the answer and
 * the mail are the same either way, and no account is looked up (only the project's own members, for
 * "already a member"). Only the sha256 of a link's token is stored.
 */
export function createProjectInvitationService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  mailer: Mailer;
  access: ProjectAccess;
}): ProjectInvitationService {
  const { dataSource, config, mailer, access } = deps;

  /** Times are taken in Node, not from `now()` in SQL, so tests can move the clock. */
  const now = () => new Date();

  return {
    async invite(actor, projectId, raw) {
      const token = randomToken(32);
      const { email, projectName } = await withLockedMembers(
        dataSource,
        actor.id,
        projectId,
        async ({ em, project, actorRole }) => {
          // Rights before the body: a viewer gets the 403 whatever they send.
          assertRole(actorRole, 'project:admin');
          const input = validate(inviteSchema, raw);
          // Members only (the owner included): an address of someone outside the project is never looked up.
          const member: unknown[] = await em.query(
            `SELECT 1 FROM project_relation r JOIN "user" u ON u.id = r.user_id
             WHERE r.project_id = $1 AND u.email = $2`,
            [project.id, input.email],
          );
          if (member.length > 0) throw new HttpError(409, ALREADY_MEMBER);
          const sentAt = now();
          await em.query(`DELETE FROM project_invitation WHERE project_id = $1 AND expires_at <= $2`, [
            project.id,
            sentAt,
          ]);
          // Inviting an address again replaces its invitation: the old link stops working.
          await em.query(
            `INSERT INTO project_invitation (project_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (project_id, email) DO UPDATE SET role = EXCLUDED.role,
               token_hash = EXCLUDED.token_hash, invited_by = EXCLUDED.invited_by,
               expires_at = EXCLUDED.expires_at, created_at = now(), updated_at = now()`,
            [
              project.id,
              input.email,
              input.role,
              sha256(token),
              actor.id,
              new Date(sentAt.getTime() + PROJECT_INVITATION_TTL_MS),
            ],
          );
          return { email: input.email, projectName: project.name };
        },
      );
      // Sent once the invitation is committed, so the link works when it arrives. A failure is logged
      // without the address or the link and does not change the answer: the owner can invite again.
      const link = `${config.editorBaseUrl}/project-invitation?token=${token}`;
      try {
        await mailer.send({ to: email, ...projectInvitationEmail(link, displayName(actor), projectName) });
      } catch (error) {
        console.error(
          `Project invitation email for project ${projectId} could not be sent (${describeError(error)})`,
        );
      }
      return { email, status: 'invited' };
    },

    async list(actorId, projectId) {
      await access.require(actorId, projectId, 'project:admin');
      const rows: { id: string; email: string; role: MemberRole; expiresAt: Date; createdAt: Date }[] =
        await dataSource.query(
          `SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"
           FROM project_invitation WHERE project_id = $1 AND expires_at > $2
           ORDER BY created_at, email`,
          [projectId, now()],
        );
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async cancel(actorId, projectId, invitationId) {
      await withLockedProject(dataSource, actorId, projectId, async ({ em, actorRole }) => {
        assertRole(actorRole, 'project:admin');
        if (!UUID.test(invitationId)) throw new HttpError(404, INVITATION_NOT_FOUND);
        const deleted: unknown[] = await em.query(
          `WITH gone AS (DELETE FROM project_invitation WHERE id = $1 AND project_id = $2 RETURNING id)
           SELECT id FROM gone`,
          [invitationId, projectId],
        );
        if (deleted.length === 0) throw new HttpError(404, INVITATION_NOT_FOUND);
      });
    },

    async resolve(raw) {
      const tokenHash = readLinkToken(raw);
      if (!tokenHash) throw new HttpError(400, INVALID_TOKEN);
      const rows: {
        email: string;
        role: MemberRole;
        projectName: string;
        firstName: string | null;
        lastName: string | null;
        hasAccount: boolean;
        pendingInvite: boolean;
      }[] = await dataSource.query(
        `SELECT i.email, i.role, p.name AS "projectName", u.first_name AS "firstName", u.last_name AS "lastName",
           ${linkAccountColumnsSql('i.email')}
         FROM project_invitation i
         JOIN project p ON p.id = i.project_id
         LEFT JOIN "user" u ON u.id = i.invited_by
         WHERE i.token_hash = $1 AND i.expires_at > $2 AND NOT ${projectBlockedSql('i.project_id')}`,
        [tokenHash, now()],
      );
      const row = rows[0];
      if (!row) throw new HttpError(400, INVALID_TOKEN);
      return {
        email: row.email,
        projectName: row.projectName,
        inviterName:
          row.firstName === null
            ? null
            : displayName({ firstName: row.firstName, lastName: row.lastName ?? '' }),
        role: row.role,
        hasAccount: row.hasAccount,
        pendingInvite: row.pendingInvite,
      };
    },

    async accept(user, raw) {
      const tokenHash = readLinkToken(validate(acceptSchema, raw).token);
      if (!tokenHash) throw new HttpError(400, INVALID_TOKEN);
      // Unlocked look-up first: a wrong or foreign link must not lock anyone's project.
      const found: { id: string; projectId: string; email: string }[] = await dataSource.query(
        `SELECT id, project_id AS "projectId", email FROM project_invitation
         WHERE token_hash = $1 AND expires_at > $2`,
        [tokenHash, now()],
      );
      const invitation = found[0];
      if (!invitation) throw new HttpError(400, INVALID_TOKEN);
      if (invitation.email !== user.email) throw new HttpError(403, WRONG_EMAIL);
      const { projectId } = invitation;

      let outcome: { joined: ProjectSummary } | 'already-member';
      try {
        outcome = await dataSource.transaction(async (em) => {
          // The project's membership rows first (the lock order of `withLockedProject`): this
          // serializes the accept with every member change, cancellation and the project's deletion.
          await lockProjectMembers(em, projectId);
          // Taking the row is what makes the link one-time: of two concurrent accepts (or an accept and
          // a cancellation) only one finds it.
          const taken: { role: MemberRole }[] = await em.query(
            `WITH taken AS (
               DELETE FROM project_invitation WHERE id = $1 AND token_hash = $2 AND expires_at > $3
               RETURNING role
             ) SELECT role FROM taken`,
            [invitation.id, tokenHash, now()],
          );
          const role = taken[0]?.role;
          if (!role) throw new HttpError(400, INVALID_TOKEN);
          // Owner disabled: nobody joins (the invitation is kept, so it works again once the owner is
          // enabled). The owner's row is read without a lock (see `isProjectBlocked`).
          if (await isProjectBlocked(em, projectId)) throw new HttpError(400, INVALID_TOKEN);
          const existing: unknown[] = await em.query(
            `SELECT 1 FROM project_relation WHERE project_id = $1 AND user_id = $2`,
            [projectId, user.id],
          );
          // Already in: the invitation is used up all the same (committed), the answer is a 409.
          if (existing.length > 0) return 'already-member' as const;
          await em.query(`INSERT INTO project_relation (project_id, user_id, role) VALUES ($1, $2, $3)`, [
            projectId,
            user.id,
            role,
          ]);
          // Read in the transaction: if the project got blocked meanwhile, nobody joins after all.
          const summary = await projectSummary(em, user.id, projectId);
          if (!summary) throw new HttpError(400, INVALID_TOKEN);
          return { joined: summary };
        });
      } catch (error) {
        // Safety nets for races the lock does not cover: the account deleted meanwhile (foreign key: the
        // session is gone with it), the user added by another way meanwhile (primary key).
        const code = (error as { code?: unknown }).code;
        if (code === '23503') throw new HttpError(401, 'Unauthorized');
        if (code === '23505') throw new HttpError(409, ALREADY_MEMBER, undefined, { projectId });
        throw error;
      }
      // The caller is a member, so the project's id is theirs to know: the page offers to open it.
      if (outcome === 'already-member') throw new HttpError(409, ALREADY_MEMBER, undefined, { projectId });
      return outcome.joined;
    },
  };
}
