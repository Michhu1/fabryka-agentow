import type { ProjectRole } from '@app/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { UUID } from '../auth/session.js';
import { Project } from '../db/entities/project.entity.js';
import { HttpError } from '../http/errors.js';
import { assertRole, isProjectBlocked, PROJECT_NOT_FOUND } from './project-access.js';

/** Membership rows of one project, read under a row lock (see `withLockedProject`). */
export type LockedProject = {
  em: EntityManager;
  project: Project;
  members: Map<string, ProjectRole>;
  actorRole: ProjectRole;
};

/**
 * Locks every membership row of `projectId` (`FOR UPDATE`, ordered by user id) in the transaction `em`
 * and returns them. A team project always has its owner's row, so this serializes every transaction
 * that takes it for the same project. Must come before anything else of the project is touched (see
 * `withLockedProject` for the lock order).
 */
export async function lockProjectMembers(
  em: EntityManager,
  projectId: string,
): Promise<Map<string, ProjectRole>> {
  const rows: { userId: string; role: ProjectRole }[] = await em.query(
    `SELECT user_id AS "userId", role FROM project_relation WHERE project_id = $1 ORDER BY user_id FOR UPDATE`,
    [projectId],
  );
  return new Map(rows.map((row) => [row.userId, row.role]));
}

/**
 * Runs `fn` in a transaction that first locks every membership row of the project. Two changes to
 * one project's members, invitations or transfer (or a change and the project's deletion) therefore
 * run one after another, and each decides on the rows as the other left them (e.g. a member never
 * joins a project being deleted, and the owner check sees the current owner).
 *
 * Lock order, kept by every transaction in the app so none can deadlock another: the user row of an
 * account that is about to own a project (create, transfer accept, account deletion) → the project's
 * membership rows (by user id; account deletion locks by project id, then user id, which is the same
 * order within one project) → the project's invitation or transfer row. Access is decided from the
 * locked rows by the same rule as `ProjectAccess.require` (membership only, 404 for strangers and for
 * a blocked project).
 */
export async function withLockedProject<T>(
  dataSource: DataSource,
  actorId: string,
  projectId: string,
  fn: (locked: LockedProject) => Promise<T>,
): Promise<T> {
  if (!UUID.test(projectId)) throw new HttpError(404, PROJECT_NOT_FOUND);
  // Unlocked check first: a stranger's request must not lock (and so hold up) someone else's project.
  const membership: unknown[] = await dataSource.query(
    `SELECT 1 FROM project_relation WHERE project_id = $1 AND user_id = $2`,
    [projectId, actorId],
  );
  if (membership.length === 0) throw new HttpError(404, PROJECT_NOT_FOUND);
  return dataSource.transaction(async (em) => {
    const members = await lockProjectMembers(em, projectId);
    // Decided again on the locked rows: the membership (or the project) may be gone by now. The block
    // comes before the role, so that even a viewer gets the 404 and not a 403.
    const actorRole = members.get(actorId);
    if (actorRole !== undefined && (await isProjectBlocked(em, projectId))) {
      throw new HttpError(404, PROJECT_NOT_FOUND);
    }
    assertRole(actorRole, 'project:viewer');
    const project = await em.findOneBy(Project, { id: projectId });
    if (!project) throw new HttpError(404, PROJECT_NOT_FOUND);
    return fn({ em, project, members, actorRole });
  });
}

/** `withLockedProject` for member changes (and invitations), which personal projects never allow. */
export function withLockedMembers<T>(
  dataSource: DataSource,
  actorId: string,
  projectId: string,
  fn: (locked: LockedProject) => Promise<T>,
): Promise<T> {
  return withLockedProject(dataSource, actorId, projectId, (locked) => {
    if (locked.project.type === 'personal') {
      throw new HttpError(400, 'Members of a personal project cannot be changed');
    }
    return fn(locked);
  });
}
