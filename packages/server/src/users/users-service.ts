import type { ApiErrorBody, DeleteUserConflict, GlobalRole, InstanceUser, UserList } from '@app/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { UUID } from '../auth/session.js';
import type { User } from '../db/entities/user.entity.js';
import { HttpError, strictBody, validate } from '../http/errors.js';
import { ownedTeamProjectCount } from '../projects/team-project-limit.js';

const USER_NOT_FOUND = 'User not found';

/** A non-negative integer in a query string, written plainly (no `1e2`, `1.5`, `-0`). */
const queryInt = (message: string, min: number, max: number) =>
  z
    .string({ error: message })
    .regex(/^\d{1,10}$/, { error: message })
    .transform(Number)
    .pipe(z.number().int().min(min, { error: message }).max(max, { error: message }));

const listSchema = z.object({
  search: z
    .string({ error: 'Search must be text' })
    .trim()
    .max(254, { error: 'Search is too long' })
    .default(''),
  skip: queryInt('Skip must be a non-negative integer', 0, 1_000_000_000).default(0),
  take: queryInt('Take must be an integer from 1 to 100', 1, 100).default(50),
});

/** `global:owner` is never given or taken through the API: the instance has exactly one owner. */
const roleSchema = strictBody({
  role: z.enum(['global:admin', 'global:member'], { error: 'Role must be global:admin or global:member' }),
});

const updateSchema = strictBody({
  disabled: z.boolean({ error: 'Disabled must be true or false' }),
});

/** The columns of `InstanceUser`; nothing else of the row (hashes, 2FA secrets) ever leaves the query. */
const INSTANCE_USER_COLUMNS = `u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName", u.role,
  u.disabled, u.mfa_enabled AS "mfaEnabled", to_char(u.last_active_at, 'YYYY-MM-DD') AS "lastActiveAt",
  (u.password_hash IS NULL) AS "isPending"`;

/** `\`, `%` and `_` match themselves in the LIKE pattern built from the search text. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export type UserService = {
  list(query: unknown): Promise<UserList>;
  changeRole(actor: User, targetId: string, input: unknown): Promise<InstanceUser>;
  update(actor: User, targetId: string, input: unknown): Promise<InstanceUser>;
  remove(actor: User, targetId: string): Promise<void>;
};

/**
 * Account management for the owner and admins (n8n: Settings → Users). Only account data is read or
 * changed here: the users' projects are never listed or opened (privacy rule) — account deletion only
 * learns how many team projects the user owns. Disabling an account also blocks the projects it owns
 * (see `projectBlockedSql`); nothing about them is changed here.
 */
export function createUserService(deps: { dataSource: DataSource }): UserService {
  const { dataSource } = deps;

  async function instanceUser(db: Pick<EntityManager, 'query'>, id: string): Promise<InstanceUser> {
    const rows: InstanceUser[] = await db.query(
      `SELECT ${INSTANCE_USER_COLUMNS} FROM "user" u WHERE u.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, USER_NOT_FOUND);
    return toInstanceUser(row);
  }

  /** The target's id, role and pending state under a row lock, so the checks hold until commit. */
  async function lockTarget(em: EntityManager, targetId: string): Promise<{ id: string; role: GlobalRole }> {
    if (!UUID.test(targetId)) throw new HttpError(404, USER_NOT_FOUND);
    const rows: { id: string; role: GlobalRole }[] = await em.query(
      `SELECT id, role FROM "user" WHERE id = $1 FOR UPDATE`,
      [targetId],
    );
    const target = rows[0];
    if (!target) throw new HttpError(404, USER_NOT_FOUND);
    return target;
  }

  /**
   * Shared rules for disabling and deleting: never yourself, never the owner, and an admin only acts
   * on members (only the owner acts on admins).
   */
  function assertMayManage(actor: User, target: { id: string; role: GlobalRole }, action: string): void {
    if (target.id === actor.id) throw new HttpError(400, `You cannot ${action} your own account`);
    if (target.role === 'global:owner') throw new HttpError(400, `The owner cannot be ${action}d`);
    if (target.role === 'global:admin' && actor.role !== 'global:owner')
      throw new HttpError(403, 'Forbidden');
  }

  return {
    async list(raw) {
      const query = validate(listSchema, raw);
      const where = query.search
        ? `WHERE u.email ILIKE $1 ESCAPE '\\' OR u.first_name ILIKE $1 ESCAPE '\\' OR u.last_name ILIKE $1 ESCAPE '\\'`
        : '';
      const params = query.search ? [likePattern(query.search)] : [];
      const counted: { count: number }[] = await dataSource.query(
        `SELECT count(*)::int AS count FROM "user" u ${where}`,
        params,
      );
      // Emails are unique: ordering by them (bytewise, independent of the database collation) is total.
      const rows: InstanceUser[] = await dataSource.query(
        `SELECT ${INSTANCE_USER_COLUMNS} FROM "user" u ${where}
         ORDER BY u.email COLLATE "C"
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.take, query.skip],
      );
      return { count: counted[0]?.count ?? 0, items: rows.map(toInstanceUser) };
    },

    async changeRole(actor, targetId, raw) {
      const input = validate(roleSchema, raw);
      return dataSource.transaction(async (em) => {
        const target = await lockTarget(em, targetId);
        if (target.id === actor.id) throw new HttpError(400, 'You cannot change your own role');
        if (target.role === 'global:owner')
          throw new HttpError(400, 'The role of the owner cannot be changed');
        // Takes effect on the target's next request: `authenticate` reads the role from the database.
        await em.query(`UPDATE "user" SET role = $2, updated_at = now() WHERE id = $1`, [
          target.id,
          input.role,
        ]);
        return instanceUser(em, target.id);
      });
    },

    async update(actor, targetId, raw) {
      const input = validate(updateSchema, raw);
      return dataSource.transaction(async (em) => {
        const target = await lockTarget(em, targetId);
        assertMayManage(actor, target, 'disable');
        // Immediate: `authenticate` and login refuse disabled users on every request, and the projects
        // the user owns are blocked for all their members (derived from this flag, so enabling the
        // account again restores them).
        await em.query(`UPDATE "user" SET disabled = $2, updated_at = now() WHERE id = $1`, [
          target.id,
          input.disabled,
        ]);
        return instanceUser(em, target.id);
      });
    },

    async remove(actor, targetId) {
      await dataSource.transaction(async (em) => {
        // FOR UPDATE on the user row also blocks new memberships of this user meanwhile (their foreign
        // key check needs a share lock on it).
        const target = await lockTarget(em, targetId);
        assertMayManage(actor, target, 'delete');
        // An owner of team projects is never deleted (also with no other members): the projects would be
        // left without an owner. The admin learns only how many — they may block the account instead,
        // which keeps the data. The count cannot grow until commit: whatever makes the user an owner
        // (create, transfer accept) locks the user row first, which we hold.
        const projectCount = await ownedTeamProjectCount(em, target.id);
        if (projectCount > 0) {
          throw new HttpError(409, 'User owns team projects', undefined, {
            projectCount,
          } satisfies Omit<DeleteUserConflict, keyof ApiErrorBody>);
        }
        // Lock the memberships of every project the user is in, ordered by (project, user) — compatible
        // with `ProjectService`, which locks one project's rows ordered by user id — before the cascades
        // below touch them (and, through `creator_id`, the project rows) in an order of their own, which
        // would deadlock with a concurrent change or deletion of one of those projects.
        await em.query(
          `SELECT project_id, user_id FROM project_relation
           WHERE project_id IN (SELECT project_id FROM project_relation WHERE user_id = $1)
           ORDER BY project_id, user_id
           FOR UPDATE`,
          [target.id],
        );
        // The personal project goes with the account; from M2 its resources are deleted with it.
        // Memberships (as editor or viewer in others' projects) and API keys cascade from the user row.
        await em.query(
          `DELETE FROM project p
           WHERE p.type = 'personal'
             AND p.id IN (SELECT project_id FROM project_relation WHERE user_id = $1 AND role = 'project:personalOwner')`,
          [target.id],
        );
        await em.query(`DELETE FROM "user" WHERE id = $1`, [target.id]);
      });
    },
  };
}

/** A fresh object with exactly the public fields, whatever the driver returned. */
function toInstanceUser(row: InstanceUser): InstanceUser {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    disabled: row.disabled,
    mfaEnabled: row.mfaEnabled,
    lastActiveAt: row.lastActiveAt,
    isPending: row.isPending,
  };
}
