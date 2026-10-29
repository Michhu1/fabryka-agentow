import type { AppConfig } from '@app/config';
import type { EntityManager } from 'typeorm';
import type { User } from '../db/entities/user.entity.js';
import { HttpError } from '../http/errors.js';

export const TEAM_PROJECT_LIMIT_REACHED = 'Team project limit reached';

/**
 * How many team projects the account may own: its own limit (a later paid plan raises it) or, when that
 * is NULL, the instance default `TEAM_PROJECTS_LIMIT` — so changing the default affects every free account.
 */
export function effectiveTeamProjectsLimit(
  user: Pick<User, 'teamProjectsLimit'>,
  config: Pick<AppConfig, 'teamProjectsLimit'>,
): number {
  return user.teamProjectsLimit ?? config.teamProjectsLimit;
}

/**
 * Team projects the user owns (`project:admin`, exactly one per team project) — what the limit counts.
 * Memberships as editor or viewer and the personal project do not count.
 */
export async function ownedTeamProjectCount(
  db: Pick<EntityManager, 'query'>,
  userId: string,
): Promise<number> {
  const rows: { count: number }[] = await db.query(
    `SELECT count(*)::int AS count
     FROM project_relation r JOIN project p ON p.id = r.project_id
     WHERE r.user_id = $1 AND r.role = 'project:admin' AND p.type = 'team'`,
    [userId],
  );
  return rows[0]?.count ?? 0;
}

/**
 * Call inside the transaction that is about to make `userId` the owner of a team project (create or a
 * transfer accept): locks the user row and throws 403 unless one more owned project fits the limit.
 * The lock serializes everything that adds owned projects to this user, so parallel requests cannot all
 * pass the count; NO KEY UPDATE does not block foreign key checks (e.g. the user joining a project
 * meanwhile). It also orders these transactions with account deletion (user row first). A user row that
 * is gone (account deleted meanwhile) → 401.
 */
export async function assertTeamProjectSlot(
  em: EntityManager,
  userId: string,
  config: Pick<AppConfig, 'teamProjectsLimit'>,
): Promise<void> {
  const rows: Pick<User, 'teamProjectsLimit'>[] = await em.query(
    `SELECT team_projects_limit AS "teamProjectsLimit" FROM "user" WHERE id = $1 FOR NO KEY UPDATE`,
    [userId],
  );
  const user = rows[0];
  if (!user) throw new HttpError(401, 'Unauthorized');
  if ((await ownedTeamProjectCount(em, userId)) >= effectiveTeamProjectsLimit(user, config)) {
    throw new HttpError(403, TEAM_PROJECT_LIMIT_REACHED);
  }
}
