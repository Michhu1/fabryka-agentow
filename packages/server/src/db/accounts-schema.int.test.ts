import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { start } from '../start.js';
import { testConfig, truncateAll } from '../test/db.js';

const config = testConfig({ PORT: '5698' });
let server: Awaited<ReturnType<typeof start>>;

const TABLES = [
  'user',
  'project',
  'project_relation',
  'invalid_auth_token',
  'api_key',
  'project_invitation',
  'project_transfer',
];

async function insertUser(email: string): Promise<string> {
  const rows = await server.dataSource.query(
    `INSERT INTO "user" (email, first_name, last_name, role) VALUES ($1, 'Jan', 'Kowalski', 'global:member') RETURNING id`,
    [email],
  );
  return rows[0].id;
}

async function insertProject(type: 'personal' | 'team'): Promise<string> {
  const rows = await server.dataSource.query(
    `INSERT INTO project (name, type) VALUES ('P', $1) RETURNING id`,
    [type],
  );
  return rows[0].id;
}

async function relate(projectId: string, userId: string, role: string): Promise<void> {
  await server.dataSource.query(
    `INSERT INTO project_relation (project_id, user_id, role) VALUES ($1, $2, $3)`,
    [projectId, userId, role],
  );
}

async function count(table: string, userId: string): Promise<number> {
  const rows = await server.dataSource.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [
    userId,
  ]);
  return rows[0].n;
}

describe('accounts schema (requires pnpm infra:up)', () => {
  beforeAll(async () => {
    server = await start(config);
  });
  afterAll(async () => server?.close());
  beforeEach(async () => truncateAll(server.dataSource));

  it('creates all account tables', async () => {
    for (const table of TABLES) {
      const rows = await server.dataSource.query(`select to_regclass($1) as t`, [`"${table}"`]);
      expect(rows[0].t, table).not.toBeNull();
    }
  });

  it('fills defaults for ids, timestamps and flags', async () => {
    const id = await insertUser('d@x.pl');
    const [user] = await server.dataSource.query(`SELECT * FROM "user" WHERE id = $1`, [id]);
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.disabled).toBe(false);
    expect(user.mfa_enabled).toBe(false);
    expect(user.settings).toEqual({});
    expect(user.password_hash).toBeNull();
    expect(user.created_at).toBeInstanceOf(Date);
    expect(user.updated_at).toBeInstanceOf(Date);
  });

  it('rejects a duplicate email', async () => {
    await insertUser('a@x.pl');
    await expect(insertUser('a@x.pl')).rejects.toThrow(/unique|duplicate/i);
  });

  it('allows only one personal project per user', async () => {
    const userId = await insertUser('a@x.pl');
    await relate(await insertProject('personal'), userId, 'project:personalOwner');
    const second = await insertProject('personal');
    await expect(relate(second, userId, 'project:personalOwner')).rejects.toThrow(/unique|duplicate/i);
    // Other roles are not limited.
    await relate(await insertProject('team'), userId, 'project:admin');
    await relate(await insertProject('team'), userId, 'project:admin');
  });

  it('deleting a user removes their project relations and api keys', async () => {
    const userId = await insertUser('a@x.pl');
    const projectId = await insertProject('team');
    await server.dataSource.query(`UPDATE project SET creator_id = $1 WHERE id = $2`, [userId, projectId]);
    await relate(projectId, userId, 'project:admin');
    await server.dataSource.query(
      `INSERT INTO api_key (user_id, label, key_hash, hint) VALUES ($1, 'k', $2, 'abcd')`,
      [userId, 'f'.repeat(64)],
    );
    expect(await count('project_relation', userId)).toBe(1);
    expect(await count('api_key', userId)).toBe(1);

    await server.dataSource.query(`DELETE FROM "user" WHERE id = $1`, [userId]);

    expect(await count('project_relation', userId)).toBe(0);
    expect(await count('api_key', userId)).toBe(0);
    const [project] = await server.dataSource.query(`SELECT creator_id FROM project WHERE id = $1`, [
      projectId,
    ]);
    expect(project.creator_id).toBeNull();
  });

  it('a new account has no own team project limit (NULL = the TEAM_PROJECTS_LIMIT default)', async () => {
    const id = await insertUser('l@x.pl');
    const [user] = await server.dataSource.query(`SELECT team_projects_limit FROM "user" WHERE id = $1`, [
      id,
    ]);
    expect(user.team_projects_limit).toBeNull();
    await server.dataSource.query(`UPDATE "user" SET team_projects_limit = 5 WHERE id = $1`, [id]);
    const [raised] = await server.dataSource.query(`SELECT team_projects_limit FROM "user" WHERE id = $1`, [
      id,
    ]);
    expect(raised.team_projects_limit).toBe(5);
  });

  it('allows at most one project:admin (the owner) per project; other roles are not limited', async () => {
    const [a, b, c] = [await insertUser('a@x.pl'), await insertUser('b@x.pl'), await insertUser('c@x.pl')];
    const project = await insertProject('team');
    await relate(project, a, 'project:admin');
    await expect(relate(project, b, 'project:admin')).rejects.toThrow(/unique|duplicate/i);
    await relate(project, b, 'project:editor');
    await relate(project, c, 'project:editor');
    // The same user may own several projects.
    await relate(await insertProject('team'), a, 'project:admin');
  });

  async function insertInvitation(projectId: string, email: string, tokenHash: string, by: string | null) {
    await server.dataSource.query(
      `INSERT INTO project_invitation (project_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'project:viewer', $3, $4, now() + interval '7 days')`,
      [projectId, email, tokenHash, by],
    );
  }

  async function insertTransfer(projectId: string, from: string, tokenHash: string) {
    await server.dataSource.query(
      `INSERT INTO project_transfer (project_id, from_user_id, to_email, token_hash, expires_at)
       VALUES ($1, $2, 'b@x.pl', $3, now() + interval '7 days')`,
      [projectId, from, tokenHash],
    );
  }

  it('project invitations: one per project and address, unique token; gone with the project', async () => {
    const owner = await insertUser('a@x.pl');
    const [p1, p2] = [await insertProject('team'), await insertProject('team')];
    await insertInvitation(p1, 'b@x.pl', 'a'.repeat(64), owner);
    await expect(insertInvitation(p1, 'b@x.pl', 'b'.repeat(64), owner)).rejects.toThrow(/unique|duplicate/i);
    await expect(insertInvitation(p2, 'c@x.pl', 'a'.repeat(64), owner)).rejects.toThrow(/unique|duplicate/i);
    await insertInvitation(p2, 'b@x.pl', 'c'.repeat(64), owner);

    // The inviter's account deleted: the invitation stays, without an inviter.
    await server.dataSource.query(`DELETE FROM "user" WHERE id = $1`, [owner]);
    const rows: { invited_by: string | null }[] = await server.dataSource.query(
      `SELECT invited_by FROM project_invitation ORDER BY token_hash`,
    );
    expect(rows).toEqual([{ invited_by: null }, { invited_by: null }]);

    await server.dataSource.query(`DELETE FROM project WHERE id = $1`, [p1]);
    const left: { project_id: string }[] = await server.dataSource.query(
      `SELECT project_id FROM project_invitation`,
    );
    expect(left).toEqual([{ project_id: p2 }]);
  });

  it('project transfers: one per project, unique token; gone with the project or the sender', async () => {
    const [a, b] = [await insertUser('a@x.pl'), await insertUser('c@x.pl')];
    const [p1, p2, p3] = [
      await insertProject('team'),
      await insertProject('team'),
      await insertProject('team'),
    ];
    await insertTransfer(p1, a, 'a'.repeat(64));
    await expect(insertTransfer(p1, b, 'b'.repeat(64))).rejects.toThrow(/unique|duplicate/i);
    await expect(insertTransfer(p2, b, 'a'.repeat(64))).rejects.toThrow(/unique|duplicate/i);
    await insertTransfer(p2, b, 'c'.repeat(64));
    await insertTransfer(p3, a, 'd'.repeat(64));

    await server.dataSource.query(`DELETE FROM project WHERE id = $1`, [p1]);
    await server.dataSource.query(`DELETE FROM "user" WHERE id = $1`, [b]);
    const left: { project_id: string }[] = await server.dataSource.query(
      `SELECT project_id FROM project_transfer`,
    );
    expect(left).toEqual([{ project_id: p3 }]);
  });

  it('migration 0004 can be reverted: both tables go, the rest stays', async () => {
    await server.dataSource.undoLastMigration();
    for (const table of ['project_invitation', 'project_transfer']) {
      const rows = await server.dataSource.query(`select to_regclass($1) as t`, [`"${table}"`]);
      expect(rows[0].t, table).toBeNull();
    }
    const rows = await server.dataSource.query(`select to_regclass('"project_relation"') as t`);
    expect(rows[0].t).not.toBeNull();
    await server.dataSource.runMigrations();
  });

  it('entities match the migrated schema (no drift)', async () => {
    const pending = await server.dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((q) => q.query)).toEqual([]);
  });

  it('migration 0003 demotes surplus admins to editors: the creator stays owner, else the earliest member', async () => {
    await server.dataSource.undoLastMigration(); // 0004
    await server.dataSource.undoLastMigration(); // 0003
    const column = await server.dataSource.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'team_projects_limit'`,
    );
    expect(column).toHaveLength(0);
    const index = await server.dataSource.query(`SELECT to_regclass('"UQ_project_relation_one_admin"') AS t`);
    expect(index[0].t).toBeNull();

    const [a, b, c] = [await insertUser('a@x.pl'), await insertUser('b@x.pl'), await insertUser('c@x.pl')];
    const at = (minute: number) => `2026-10-01T10:0${minute}:00Z`;
    async function relateAt(projectId: string, userId: string, role: string, minute: number) {
      await server.dataSource.query(
        `INSERT INTO project_relation (project_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)`,
        [projectId, userId, role, at(minute)],
      );
    }
    // Created by C, who joined as admin last.
    const byCreator = await insertProject('team');
    await server.dataSource.query(`UPDATE project SET creator_id = $1 WHERE id = $2`, [c, byCreator]);
    await relateAt(byCreator, a, 'project:admin', 1);
    await relateAt(byCreator, b, 'project:viewer', 2);
    await relateAt(byCreator, c, 'project:admin', 3);
    // Creator gone (NULL) or no longer an admin: the earliest admin stays.
    const noCreator = await insertProject('team');
    await relateAt(noCreator, c, 'project:admin', 2);
    await relateAt(noCreator, b, 'project:admin', 1);
    await relateAt(noCreator, a, 'project:admin', 3);
    const creatorEditor = await insertProject('team');
    await server.dataSource.query(`UPDATE project SET creator_id = $1 WHERE id = $2`, [a, creatorEditor]);
    await relateAt(creatorEditor, a, 'project:editor', 1);
    await relateAt(creatorEditor, c, 'project:admin', 3);
    await relateAt(creatorEditor, b, 'project:admin', 2);

    await server.dataSource.runMigrations();

    async function roles(projectId: string) {
      const rows: { user_id: string; role: string }[] = await server.dataSource.query(
        `SELECT user_id, role FROM project_relation WHERE project_id = $1`,
        [projectId],
      );
      return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
    }
    expect(await roles(byCreator)).toEqual({
      [a]: 'project:editor',
      [b]: 'project:viewer',
      [c]: 'project:admin',
    });
    expect(await roles(noCreator)).toEqual({
      [a]: 'project:editor',
      [b]: 'project:admin',
      [c]: 'project:editor',
    });
    expect(await roles(creatorEditor)).toEqual({
      [a]: 'project:editor',
      [b]: 'project:admin',
      [c]: 'project:editor',
    });
    const [user] = await server.dataSource.query(`SELECT team_projects_limit FROM "user" WHERE id = $1`, [a]);
    expect(user.team_projects_limit).toBeNull();
  });

  it('migrations can be reverted and re-applied', async () => {
    for (let i = 0; i < 3; i++) await server.dataSource.undoLastMigration();
    for (const table of TABLES) {
      const rows = await server.dataSource.query(`select to_regclass($1) as t`, [`"${table}"`]);
      expect(rows[0].t, table).toBeNull();
    }
    await server.dataSource.runMigrations();
    const rows = await server.dataSource.query(`select to_regclass('"UQ_project_relation_one_admin"') as t`);
    expect(rows[0].t).not.toBeNull();
  });
});
