import type { AppConfig } from '@app/config';
import type { MemberRole, ProjectDetails, ProjectMember, ProjectSummary } from '@app/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { Project } from '../db/entities/project.entity.js';
import { ProjectRelation } from '../db/entities/project-relation.entity.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import {
  assertRole,
  PROJECT_NOT_FOUND,
  type ProjectAccess,
  projectBlockedSql,
  ROLE_RANK,
} from './project-access.js';
import {
  type LockedProject,
  withLockedMembers as lockedMembers,
  withLockedProject as lockedProject,
} from './project-lock.js';
import { assertTeamProjectSlot } from './team-project-limit.js';

const nameField = z
  .string({ error: 'Name is required' })
  .trim()
  .min(1, { error: 'Name is required' })
  .max(255, { error: 'Name must be at most 255 characters' });

/** Text up to 512 characters; `null` (or only whitespace) clears it. */
const descriptionField = z
  .string({ error: 'Description must be text' })
  .trim()
  .max(512, { error: 'Description must be at most 512 characters' })
  .transform((value) => (value === '' ? null : value))
  .nullable();

/**
 * `{ type: 'emoji', value }` or `null` to clear. The value is not checked to be an emoji: the editor
 * renders it as text (escaped), and 16 UTF-16 units fit any emoji sequence (flags, skin tones, ZWJ).
 */
const iconField = z
  .strictObject(
    {
      type: z.literal('emoji', { error: 'Invalid icon' }),
      value: z
        .string({ error: 'Invalid icon' })
        .min(1, { error: 'Invalid icon' })
        .max(16, { error: 'Invalid icon' }),
    },
    { error: 'Invalid icon' },
  )
  .nullable();

const createSchema = strictBody({
  name: nameField,
  icon: iconField.optional(),
  description: descriptionField.optional(),
});

const updateSchema = strictBody({
  name: nameField.optional(),
  icon: iconField.optional(),
  description: descriptionField.optional(),
});

/**
 * Roles the owner can give members (by role change or invitation). A team project has exactly one
 * `project:admin` — its owner (the creator, or whoever accepted a transfer) — and `project:personalOwner`
 * exists only on personal projects: neither is ever assigned through these endpoints.
 */
export const memberRoleField = z.enum(['project:editor', 'project:viewer'] satisfies MemberRole[], {
  error: 'Role must be project:editor or project:viewer',
});

const changeRoleSchema = strictBody({ role: memberRoleField });

const MEMBER_NOT_FOUND = 'Member not found';
const OWNER_PROTECTED = 'The project owner cannot be removed or demoted';
const OWNER_CANNOT_LEAVE = 'The project owner cannot leave the project; transfer it first';

/**
 * Names are sorted in Node (Polish ICU collation), not by the database: the order is then the same on
 * every PostgreSQL install whatever its collation, and "Łódź" comes after "Lublin", not after "Zebra".
 * Ties (equal names) fall back to the id, so the order is always deterministic.
 */
const collator = new Intl.Collator('pl');

type Queryable = Pick<EntityManager, 'query'>;

/** Summaries of the user's projects (optionally just one), unsorted. */
async function summaries(db: Queryable, userId: string, projectId?: string): Promise<ProjectSummary[]> {
  const rows: ProjectSummary[] = await db.query(
    `SELECT p.id, p.name, p.type, p.icon, p.description, r.role,
       (SELECT count(*)::int FROM project_relation m WHERE m.project_id = p.id) AS "memberCount"
     FROM project_relation r
     JOIN project p ON p.id = r.project_id
     WHERE r.user_id = $1 AND NOT ${projectBlockedSql('p.id')}
       ${projectId === undefined ? '' : 'AND p.id = $2'}`,
    projectId === undefined ? [userId] : [userId, projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    icon: row.icon,
    description: row.description,
    role: row.role,
    memberCount: row.memberCount,
  }));
}

/**
 * The user's summary of one project they are a member of, blocked projects excluded; undefined
 * otherwise. Takes a transaction's manager, so a membership just written there is already visible.
 */
export async function projectSummary(
  db: Queryable,
  userId: string,
  projectId: string,
): Promise<ProjectSummary | undefined> {
  return (await summaries(db, userId, projectId))[0];
}

export type ProjectService = {
  /** The user's projects: the personal one first, then team projects by name (`/rest/projects/my-projects`, `/api/v1/projects`). */
  listForUser(userId: string): Promise<ProjectSummary[]>;
  personal(userId: string): Promise<ProjectSummary>;
  details(userId: string, projectId: string): Promise<ProjectDetails>;
  create(userId: string, input: unknown): Promise<ProjectDetails>;
  update(userId: string, projectId: string, input: unknown): Promise<ProjectDetails>;
  remove(userId: string, projectId: string): Promise<void>;
  changeMemberRole(
    actorId: string,
    projectId: string,
    targetUserId: string,
    input: unknown,
  ): Promise<ProjectDetails>;
  removeMember(actorId: string, projectId: string, targetUserId: string): Promise<void>;
};

/**
 * Team projects, members and roles (n8n: `/rest/projects`). Every read and write is decided by the
 * user's membership only — see `createProjectAccess` for the privacy rule — and a blocked project (owner
 * disabled) is treated as nonexistent everywhere.
 *
 * Unlike n8n, a team project has exactly one owner (`project:admin`): its creator. Members are editors or
 * viewers; the owner can be neither demoted nor removed, and cannot leave (handing the project over is
 * a transfer, see project-transfers.ts). Members join only by accepting an invitation (project-
 * invitations.ts). The database enforces "at most one" (`UQ_project_relation_one_admin`); "at least
 * one" holds because nothing changes or deletes the owner's relation except an accepted transfer, which
 * promotes the recipient in the same transaction.
 */
export function createProjectService(deps: {
  dataSource: DataSource;
  config: AppConfig;
  access: ProjectAccess;
}): ProjectService {
  const { dataSource, config, access } = deps;
  const withLockedProject = <T>(actorId: string, projectId: string, fn: (l: LockedProject) => Promise<T>) =>
    lockedProject(dataSource, actorId, projectId, fn);
  const withLockedMembers = <T>(actorId: string, projectId: string, fn: (l: LockedProject) => Promise<T>) =>
    lockedMembers(dataSource, actorId, projectId, fn);

  async function members(db: Queryable, projectId: string): Promise<ProjectMember[]> {
    const rows: ProjectMember[] = await db.query(
      `SELECT u.id AS "userId", u.email, u.first_name AS "firstName", u.last_name AS "lastName", r.role
       FROM project_relation r
       JOIN "user" u ON u.id = r.user_id
       WHERE r.project_id = $1`,
      [projectId],
    );
    // The owner first, then editors, viewers, each by name; the email (unique) makes the order total.
    return rows.sort(
      (a, b) =>
        ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
        collator.compare(`${a.firstName} ${a.lastName}`, `${b.firstName} ${b.lastName}`) ||
        a.email.localeCompare(b.email),
    );
  }

  async function buildDetails(db: Queryable, userId: string, projectId: string): Promise<ProjectDetails> {
    const [summary] = await summaries(db, userId, projectId);
    if (!summary) throw new HttpError(404, PROJECT_NOT_FOUND);
    return { ...summary, members: await members(db, projectId) };
  }

  return {
    async listForUser(userId) {
      const rows = await summaries(dataSource, userId);
      return rows.sort(
        (a, b) =>
          Number(b.type === 'personal') - Number(a.type === 'personal') ||
          collator.compare(a.name, b.name) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    },

    async personal(userId) {
      const rows = await summaries(dataSource, userId);
      const personal = rows.find((row) => row.role === 'project:personalOwner');
      if (!personal) throw new HttpError(404, PROJECT_NOT_FOUND);
      return personal;
    },

    async details(userId, projectId) {
      await access.require(userId, projectId, 'project:viewer');
      return buildDetails(dataSource, userId, projectId);
    },

    async create(userId, raw) {
      const input = validate(createSchema, raw);
      const projectId = await dataSource.transaction(async (em) => {
        // Locks the creator's row: their concurrent creates cannot all pass the limit, and a concurrent
        // deletion of the account either sees this project (409) or happens first (401 here).
        await assertTeamProjectSlot(em, userId, config);
        const project = await em.save(
          em.create(Project, {
            name: input.name,
            type: 'team',
            icon: input.icon ?? null,
            description: input.description ?? null,
            creatorId: userId,
          }),
        );
        // The creator is the owner, the only `project:admin` of the project.
        await em.insert(ProjectRelation, { projectId: project.id, userId, role: 'project:admin' });
        return project.id;
      });
      return buildDetails(dataSource, userId, projectId);
    },

    async update(userId, projectId, raw) {
      // Access first: a stranger gets the 404 whatever the body looks like. Only the owner (or the
      // personal project's owner) changes the settings.
      const { project } = await access.require(userId, projectId, 'project:admin');
      const input = validate(updateSchema, raw);
      if (project.type === 'personal' && (input.name !== undefined || input.description !== undefined)) {
        // Its name follows the owner's name and email (see PATCH /rest/me).
        throw new HttpError(400, 'Only the icon of a personal project can be changed');
      }
      const changes: Partial<Pick<Project, 'name' | 'icon' | 'description'>> = {};
      if (input.name !== undefined) changes.name = input.name;
      if (input.icon !== undefined) changes.icon = input.icon;
      if (input.description !== undefined) changes.description = input.description;
      if (Object.keys(changes).length > 0) {
        await dataSource.getRepository(Project).update({ id: project.id }, changes);
      }
      return buildDetails(dataSource, userId, project.id);
    },

    async remove(userId, projectId) {
      // Under the membership lock, like member changes: deleting the project (and with it, by cascade,
      // its memberships, invitations and transfer) while an invitation is accepted would otherwise
      // deadlock with the insert's foreign key check on the project row.
      await withLockedProject(userId, projectId, async ({ em, project, actorRole }) => {
        // Rights first: a stranger gets the 404 also for someone's personal project, not the 400.
        assertRole(actorRole, 'project:admin');
        if (project.type === 'personal') throw new HttpError(400, 'Personal project cannot be deleted');
        // Memberships, invitations and a pending transfer go with it (ON DELETE CASCADE). From M2 the project's resources are moved or
        // deleted here as well.
        await em.delete(Project, { id: project.id, type: 'team' });
      });
    },

    async changeMemberRole(actorId, projectId, targetUserId, raw) {
      await withLockedMembers(actorId, projectId, async ({ em, members: memberRoles, actorRole }) => {
        assertRole(actorRole, 'project:admin');
        const input = validate(changeRoleSchema, raw);
        // A malformed id is simply not in the map: no query sees it.
        const current = memberRoles.get(targetUserId);
        if (current === undefined) throw new HttpError(404, MEMBER_NOT_FOUND);
        // Only the owner gets here, so this is the owner trying to demote themselves.
        if (current === 'project:admin') throw new HttpError(409, OWNER_PROTECTED);
        if (current === input.role) return;
        await em.update(ProjectRelation, { projectId, userId: targetUserId }, { role: input.role });
      });
      return buildDetails(dataSource, actorId, projectId);
    },

    async removeMember(actorId, projectId, targetUserId) {
      await withLockedMembers(actorId, projectId, async ({ em, members: memberRoles, actorRole }) => {
        // Members may leave a project; removing someone else takes the owner.
        if (targetUserId !== actorId) assertRole(actorRole, 'project:admin');
        const current = memberRoles.get(targetUserId);
        if (current === undefined) throw new HttpError(404, MEMBER_NOT_FOUND);
        if (current === 'project:admin') {
          throw new HttpError(409, targetUserId === actorId ? OWNER_CANNOT_LEAVE : OWNER_PROTECTED);
        }
        await em.delete(ProjectRelation, { projectId, userId: targetUserId });
      });
    },
  };
}
