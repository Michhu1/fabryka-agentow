import type { ProjectRole } from '@app/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { normalizeId, UUID } from '../auth/session.js';
import type { Project } from '../db/entities/project.entity.js';
import { ProjectRelation } from '../db/entities/project-relation.entity.js';
import { HttpError } from '../http/errors.js';

/** How much a project role may do; `personalOwner` is the admin of a personal project. */
export const ROLE_RANK: Record<ProjectRole, number> = {
  'project:viewer': 1,
  'project:editor': 2,
  'project:admin': 3,
  'project:personalOwner': 3,
};

/**
 * One message for "no such project" and "not your project": a stranger must not be able to tell which
 * of the two an id is (Review Focus 5).
 */
export const PROJECT_NOT_FOUND = 'Project not found';

/**
 * Throws unless `role` (the user's membership role, undefined = not a member) reaches `minRole`:
 * no membership → 404 `Project not found`, too low → 403 `Forbidden`.
 */
export function assertRole(role: ProjectRole | undefined, minRole: ProjectRole): asserts role is ProjectRole {
  if (role === undefined) throw new HttpError(404, PROJECT_NOT_FOUND);
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw new HttpError(403, 'Forbidden');
}

type Queryable = Pick<EntityManager, 'query'>;

/**
 * SQL condition "the project `projectId` (an SQL expression, never request input) is blocked": its owner
 * — the `project:admin` of a team project, the `project:personalOwner` of a personal one — has a disabled
 * account. A blocked project behaves exactly like one that does not exist: nobody gets in, it is in no
 * list, and its data stays untouched. Nothing is stored on the project, so enabling the owner restores
 * everything. Use `NOT ${projectBlockedSql(...)}` in every query that lists or opens projects.
 */
export function projectBlockedSql(projectId: string): string {
  return `EXISTS (
    SELECT 1 FROM project_relation owner_rel JOIN "user" owner_user ON owner_user.id = owner_rel.user_id
    WHERE owner_rel.project_id = ${projectId}
      AND owner_rel.role IN ('project:admin', 'project:personalOwner') AND owner_user.disabled
  )`;
}

/**
 * Whether the project is blocked (see `projectBlockedSql`). Reads the owner's account row without a
 * lock: disabling an account locks only that row, and account deletion locks the user row before
 * membership rows, so locking it here (after the membership rows) could deadlock with deletion. A
 * request already past this check when the owner is disabled finishes like any request in flight; every
 * later one sees the block.
 */
export async function isProjectBlocked(db: Queryable, projectId: string): Promise<boolean> {
  const rows: { blocked: boolean }[] = await db.query(`SELECT ${projectBlockedSql('$1')} AS blocked`, [
    projectId,
  ]);
  return rows[0]?.blocked === true;
}

export type ProjectAccess = {
  /**
   * The project and the user's role in it, if the user is a member with at least `minRole` and the
   * project is not blocked (owner disabled → the same 404 as a stranger gets).
   */
  require(
    userId: string,
    projectId: string,
    minRole: ProjectRole,
  ): Promise<{ project: Project; role: ProjectRole }>;
  /** Ids of every project the user is a member of, blocked projects left out. */
  projectIdsFor(userId: string): Promise<string[]>;
};

/**
 * The only gate to project data. Access comes from membership (`project_relation`) alone: the global
 * role (`global:owner`/`global:admin`) grants nothing here, because on this public platform instance
 * admins manage accounts but never see other people's projects (unlike n8n). A blocked project (its
 * owner's account disabled, see `projectBlockedSql`) is closed to every member.
 *
 * **Rule for M2+:** every query for a project's resources (workflows, credentials, executions, …) either
 * goes through `require` first or filters by `projectIdsFor` — never by an id taken from the request alone.
 */
export function createProjectAccess(dataSource: DataSource): ProjectAccess {
  return {
    async require(rawUserId, rawProjectId, minRole) {
      // A malformed id cannot exist: same 404 as any other unknown project, without a query
      // (PostgreSQL would reject it as a uuid and turn it into a 500).
      if (!UUID.test(rawProjectId) || !UUID.test(rawUserId)) throw new HttpError(404, PROJECT_NOT_FOUND);
      const [userId, projectId] = [normalizeId(rawUserId), normalizeId(rawProjectId)];
      const relation = await dataSource
        .getRepository(ProjectRelation)
        .findOne({ where: { projectId, userId }, relations: { project: true } });
      // Blocked before rights: a member whose role is too low must get the 404 too, not a 403 that
      // would tell them the project is still there.
      if (relation && (await isProjectBlocked(dataSource, projectId))) {
        throw new HttpError(404, PROJECT_NOT_FOUND);
      }
      assertRole(relation?.role, minRole);
      if (!relation?.project) throw new HttpError(404, PROJECT_NOT_FOUND);
      return { project: relation.project, role: relation.role };
    },

    async projectIdsFor(rawUserId) {
      if (!UUID.test(rawUserId)) return [];
      const rows: { projectId: string }[] = await dataSource.query(
        `SELECT r.project_id AS "projectId" FROM project_relation r
         WHERE r.user_id = $1 AND NOT ${projectBlockedSql('r.project_id')}`,
        [normalizeId(rawUserId)],
      );
      return rows.map((row) => row.projectId);
    },
  };
}
