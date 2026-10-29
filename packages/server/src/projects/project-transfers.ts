import type { AppConfig } from '@app/config';
import type {
  ProjectSummary,
  ProjectTransfer,
  ProjectTransferInfo,
  ProjectTransferResult,
} from '@app/shared';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import {
  type AuthService,
  CURRENT_PASSWORD_REQUIRED,
  currentPasswordField,
  emailField,
} from '../auth/auth-service.js';
import { randomToken, sha256 } from '../crypto/password.js';
import type { User } from '../db/entities/user.entity.js';
import { describeError } from '../describe-error.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import type { Mailer } from '../mail/mailer.js';
import { projectTransferEmail } from '../mail/templates.js';
import { assertRole, isProjectBlocked, type ProjectAccess, projectBlockedSql } from './project-access.js';
import {
  displayName,
  linkAccountColumnsSql,
  linkTokenField,
  readLinkToken,
  transferSenderIsOwnerSql,
} from './project-links.js';
import { lockProjectMembers, withLockedProject } from './project-lock.js';
import { projectSummary } from './project-service.js';
import { assertTeamProjectSlot } from './team-project-limit.js';

/** How long a transfer link works. */
export const PROJECT_TRANSFER_TTL_MS = 7 * 24 * 60 * 60_000;

const INVALID_TOKEN = 'Invalid transfer token';
const TRANSFER_NOT_FOUND = 'Transfer not found';
const WRONG_EMAIL = 'This transfer is for a different email address';

const requestSchema = strictBody({
  email: emailField,
  currentPassword: currentPasswordField.optional(),
  mfaCode: z.string({ error: 'Invalid two-factor code' }).max(64).optional(),
});
const acceptSchema = strictBody({ token: linkTokenField(INVALID_TOKEN) });

export type ProjectTransferService = {
  /**
   * The owner asks to hand the project over to an email address, confirmed with the 2FA code (2FA on)
   * or the current password; replaces a pending request. Same answer and always a mail, whether or not
   * the address has an account.
   */
  request(actor: User, projectId: string, input: unknown): Promise<ProjectTransferResult>;
  /** The pending (not expired) transfer, or null; owner only. */
  pending(actorId: string, projectId: string): Promise<ProjectTransfer | null>;
  cancel(actorId: string, projectId: string): Promise<void>;
  /** What the link is for; 400 `Invalid transfer token` for anything else. Public. */
  resolve(token: unknown): Promise<ProjectTransferInfo>;
  /** Makes the signed-in recipient the owner and the previous owner an editor; one time only. */
  accept(user: User, input: unknown): Promise<ProjectSummary>;
};

/**
 * Handing a team project over to another account (owner decision 2; n8n has no such flow). Only the
 * owner asks, re-confirming who they are; the recipient accepts through a one-time link valid for 7
 * days, signed in with the address it was sent to, and needs a free slot under their team project
 * limit. Accepting swaps the roles in one transaction, so the project has exactly one owner before and
 * after. Only the sha256 of a link's token is stored.
 */
export function createProjectTransferService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  mailer: Mailer;
  access: ProjectAccess;
  auth: AuthService;
}): ProjectTransferService {
  const { dataSource, config, mailer, access, auth } = deps;

  /** Times are taken in Node, not from `now()` in SQL, so tests can move the clock. */
  const now = () => new Date();

  return {
    async request(actor, projectId, raw) {
      // Rights before the body: a member gets the 403 (a stranger the 404) whatever they send.
      const { project } = await access.require(actor.id, projectId, 'project:admin');
      if (project.type === 'personal') throw new HttpError(400, 'Personal project cannot be transferred');
      const input = validate(requestSchema, raw);
      if (input.email === actor.email) throw new HttpError(400, 'You already own this project');
      // Proof that the owner, not just their session, is asking — before any transaction is opened
      // (bcrypt holds no connection). With 2FA on, the stronger factor is required.
      if (actor.mfaEnabled) {
        await auth.verifyCurrentSecondFactor(actor, input.mfaCode);
      } else {
        if (!input.currentPassword) throw new HttpError(400, CURRENT_PASSWORD_REQUIRED);
        await auth.verifyCurrentPassword(actor, input.currentPassword);
      }

      const token = randomToken(32);
      const sentAt = now();
      const expiresAt = new Date(sentAt.getTime() + PROJECT_TRANSFER_TTL_MS);
      const projectName = await withLockedProject(
        dataSource,
        actor.id,
        project.id,
        async ({ em, actorRole }) => {
          // Decided again on the locked rows: a transfer accepted meanwhile made the actor an editor.
          assertRole(actorRole, 'project:admin');
          // One pending transfer per project: a new request replaces the old one, whose link dies.
          await em.query(
            `INSERT INTO project_transfer (project_id, from_user_id, to_email, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id) DO UPDATE SET from_user_id = EXCLUDED.from_user_id,
             to_email = EXCLUDED.to_email, token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at, created_at = now(), updated_at = now()`,
            [project.id, actor.id, input.email, sha256(token), expiresAt],
          );
          return project.name;
        },
      );
      // Sent once the request is committed. A failure is logged without the address or the link and
      // does not change the answer: the owner can ask again.
      const link = `${config.editorBaseUrl}/project-transfer?token=${token}`;
      try {
        await mailer.send({
          to: input.email,
          ...projectTransferEmail(link, displayName(actor), projectName),
        });
      } catch (error) {
        console.error(
          `Project transfer email for project ${project.id} could not be sent (${describeError(error)})`,
        );
      }
      return { email: input.email, expiresAt: expiresAt.toISOString() };
    },

    async pending(actorId, projectId) {
      await access.require(actorId, projectId, 'project:admin');
      const rows: { email: string; expiresAt: Date; createdAt: Date }[] = await dataSource.query(
        `SELECT to_email AS email, expires_at AS "expiresAt", created_at AS "createdAt"
         FROM project_transfer WHERE project_id = $1 AND expires_at > $2`,
        [projectId, now()],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        email: row.email,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      };
    },

    async cancel(actorId, projectId) {
      await withLockedProject(dataSource, actorId, projectId, async ({ em, actorRole }) => {
        assertRole(actorRole, 'project:admin');
        const deleted: unknown[] = await em.query(
          `WITH gone AS (DELETE FROM project_transfer WHERE project_id = $1 RETURNING id) SELECT id FROM gone`,
          [projectId],
        );
        if (deleted.length === 0) throw new HttpError(404, TRANSFER_NOT_FOUND);
      });
    },

    async resolve(raw) {
      const tokenHash = readLinkToken(raw);
      if (!tokenHash) throw new HttpError(400, INVALID_TOKEN);
      const rows: {
        email: string;
        projectName: string;
        firstName: string;
        lastName: string;
        hasAccount: boolean;
        pendingInvite: boolean;
      }[] = await dataSource.query(
        `SELECT t.to_email AS email, p.name AS "projectName", u.first_name AS "firstName",
           u.last_name AS "lastName", ${linkAccountColumnsSql('t.to_email')}
         FROM project_transfer t
         JOIN project p ON p.id = t.project_id
         JOIN "user" u ON u.id = t.from_user_id
         WHERE t.token_hash = $1 AND t.expires_at > $2 AND NOT ${projectBlockedSql('t.project_id')}
           AND ${transferSenderIsOwnerSql('t')}`,
        [tokenHash, now()],
      );
      const row = rows[0];
      if (!row) throw new HttpError(400, INVALID_TOKEN);
      return {
        email: row.email,
        projectName: row.projectName,
        fromName: displayName(row),
        hasAccount: row.hasAccount,
        pendingInvite: row.pendingInvite,
      };
    },

    async accept(user, raw) {
      const tokenHash = readLinkToken(validate(acceptSchema, raw).token);
      if (!tokenHash) throw new HttpError(400, INVALID_TOKEN);
      // Unlocked look-up first: a wrong or foreign link must not lock anyone's rows.
      const found: { id: string; projectId: string; email: string }[] = await dataSource.query(
        `SELECT id, project_id AS "projectId", to_email AS email FROM project_transfer
         WHERE token_hash = $1 AND expires_at > $2`,
        [tokenHash, now()],
      );
      const transfer = found[0];
      if (!transfer) throw new HttpError(400, INVALID_TOKEN);
      if (transfer.email !== user.email) throw new HttpError(403, WRONG_EMAIL);
      const { projectId } = transfer;

      try {
        return await dataSource.transaction(async (em) => {
          // Lock order (see `withLockedProject`): the recipient's user row first — this serializes the
          // accept with the recipient's own creates and other accepts (so the limit holds) and with
          // the deletion of their account — and over the limit → 403, the transfer stays pending.
          await assertTeamProjectSlot(em, user.id, config);
          // Then the project's membership rows: the swap below decides on them as they are.
          const members = await lockProjectMembers(em, projectId);
          // Taking the row makes the link one-time: of two accepts (or an accept and a cancellation or
          // a replacing request) only one finds it with this token.
          const taken: { fromUserId: string }[] = await em.query(
            `WITH taken AS (
               DELETE FROM project_transfer WHERE id = $1 AND token_hash = $2 AND expires_at > $3
               RETURNING from_user_id
             ) SELECT from_user_id AS "fromUserId" FROM taken`,
            [transfer.id, tokenHash, now()],
          );
          const fromUserId = taken[0]?.fromUserId;
          // Gone, or stale: whoever asked must still be the owner (and not the recipient themselves).
          if (!fromUserId || fromUserId === user.id || members.get(fromUserId) !== 'project:admin') {
            throw new HttpError(400, INVALID_TOKEN);
          }
          // Owner disabled: the project is closed, nothing changes (the transfer stays pending).
          if (await isProjectBlocked(em, projectId)) throw new HttpError(400, INVALID_TOKEN);
          // The old owner steps down first: at most one `project:admin` per project, checked per statement.
          await em.query(
            `UPDATE project_relation SET role = 'project:editor', updated_at = now()
             WHERE project_id = $1 AND user_id = $2`,
            [projectId, fromUserId],
          );
          // The recipient may already be an editor or viewer of the project.
          await em.query(
            `INSERT INTO project_relation (project_id, user_id, role) VALUES ($1, $2, 'project:admin')
             ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'project:admin', updated_at = now()`,
            [projectId, user.id],
          );
          // Read in the transaction, as the new owner sees it (never blocked: its owner just signed in).
          const summary = await projectSummary(em, user.id, projectId);
          if (!summary) throw new HttpError(400, INVALID_TOKEN);
          return summary;
        });
      } catch (error) {
        // Safety net: the recipient's account was deleted meanwhile (foreign key) — so is the session.
        if ((error as { code?: unknown }).code === '23503') throw new HttpError(401, 'Unauthorized');
        throw error;
      }
    },
  };
}
