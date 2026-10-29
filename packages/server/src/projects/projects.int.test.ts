import { randomUUID } from 'node:crypto';
import type { ProjectDetails, ProjectSummary } from '@app/shared';
import type express from 'express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';
import { mailedToken } from '../test/projects.js';
import { createProjectAccess } from './project-access.js';
import { createProjectService } from './project-service.js';
import { ownedTeamProjectCount } from './team-project-limit.js';

let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const PASSWORD = 'Haslo123';
const NOT_FOUND = { message: 'Project not found' };
const FORBIDDEN = { message: 'Forbidden' };
const OWNER_PROTECTED = { message: 'The project owner cannot be removed or demoted' };
const OWNER_CANNOT_LEAVE = { message: 'The project owner cannot leave the project; transfer it first' };
const BAD_MEMBER_ROLE = { message: 'Role must be project:editor or project:viewer' };

type TestUser = { id: string; email: string; cookie: string; personalProjectId: string };
/** A is the first signup, so also `global:owner` of the instance; B and C are `global:member`. */
let A: TestUser;
let B: TestUser;
let C: TestUser;

async function signup(email: string, firstName: string, lastName: string): Promise<TestUser> {
  const res = await request(app)
    .post('/rest/signup')
    .send({ email, firstName, lastName, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return { id: res.body.id, email, cookie, personalProjectId: res.body.personalProjectId };
}

function get(user: TestUser, path: string) {
  return request(app).get(`/rest${path}`).set('Cookie', user.cookie);
}
function post(user: TestUser, path: string, body: Record<string, unknown>) {
  return request(app).post(`/rest${path}`).set('Cookie', user.cookie).send(body);
}
function patch(user: TestUser, path: string, body: Record<string, unknown>) {
  return request(app).patch(`/rest${path}`).set('Cookie', user.cookie).send(body);
}
function del(user: TestUser, path: string) {
  return request(app)
    .delete(`/rest${path}`)
    .set('Cookie', user.cookie)
    .set('Content-Type', 'application/json');
}

async function createProject(user: TestUser, name = 'Marketing'): Promise<ProjectDetails> {
  const res = await post(user, '/projects', { name });
  expect(res.status).toBe(200);
  return res.body;
}

/** The real way in: the owner invites, the member accepts the mailed link. Returns the details. */
async function addMember(owner: TestUser, projectId: string, member: TestUser, role: string) {
  const invited = await post(owner, `/projects/${projectId}/invitations`, { email: member.email, role });
  expect(invited.status).toBe(200);
  const token = mailedToken(mailer, member.email, 'project-invitation');
  const accepted = await post(member, '/project-invitations/accept', { token });
  expect(accepted.status).toBe(200);
  const details = await get(owner, `/projects/${projectId}`);
  expect(details.status).toBe(200);
  return details.body as ProjectDetails;
}

async function myProjects(user: TestUser): Promise<ProjectSummary[]> {
  const res = await get(user, '/projects/my-projects');
  expect(res.status).toBe(200);
  return res.body;
}

function roleOf(details: ProjectDetails, user: TestUser) {
  return details.members.find((m) => m.userId === user.id)?.role;
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  // A fresh app per test: fresh in-memory rate-limit counters (signup allows 5 per minute).
  mailer = createFakeMailer();
  app = createApp({ config: testConfig(), checks: [], dataSource, mailer });
  A = await signup('anna@firma.pl', 'Anna', 'Adamska');
  B = await signup('bartek@firma.pl', 'Bartek', 'Bielski');
  C = await signup('celina@firma.pl', 'Celina', 'Cicha');
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe('session required', () => {
  it.each([
    ['get', '/rest/projects/my-projects'],
    ['get', '/rest/projects/personal'],
    ['get', `/rest/projects/${randomUUID()}`],
    ['post', '/rest/projects'],
    ['patch', `/rest/projects/${randomUUID()}`],
    ['delete', `/rest/projects/${randomUUID()}`],
    ['patch', `/rest/projects/${randomUUID()}/members/${randomUUID()}`],
    ['delete', `/rest/projects/${randomUUID()}/members/${randomUUID()}`],
  ] as const)('%s %s → 401', async (method, path) => {
    const res = await request(app)[method](path).set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(401);
  });
});

describe('listing and creating', () => {
  it('A creates a project → A sees it as project:admin, B does not', async () => {
    const created = await createProject(A, '  Marketing  ');
    expect(created).toMatchObject({
      name: 'Marketing',
      type: 'team',
      icon: null,
      description: null,
      role: 'project:admin',
      memberCount: 1,
    });
    expect(created.members).toEqual([
      { userId: A.id, email: A.email, firstName: 'Anna', lastName: 'Adamska', role: 'project:admin' },
    ]);

    const mine = await myProjects(A);
    expect(mine.map((p) => p.id)).toEqual([A.personalProjectId, created.id]);
    expect(mine[1]).toEqual({
      id: created.id,
      name: 'Marketing',
      type: 'team',
      icon: null,
      description: null,
      role: 'project:admin',
      memberCount: 1,
    });

    const theirs = await myProjects(B);
    expect(theirs.map((p) => p.id)).toEqual([B.personalProjectId]);
  });

  it('my-projects: the personal project first, then team projects alphabetically (Polish order)', async () => {
    for (const name of ['zeta', 'Łódź', 'alfa']) await createProject(A, name);
    const mine = await myProjects(A);
    expect(mine.map((p) => p.name)).toEqual(['Anna Adamska <anna@firma.pl>', 'alfa', 'Łódź', 'zeta']);
    expect(mine[0]).toMatchObject({ type: 'personal', role: 'project:personalOwner', memberCount: 1 });
  });

  it('GET /projects/personal → the own personal project', async () => {
    const res = await get(B, '/projects/personal');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: B.personalProjectId,
      name: 'Bartek Bielski <bartek@firma.pl>',
      type: 'personal',
      icon: null,
      description: null,
      role: 'project:personalOwner',
      memberCount: 1,
    });
  });

  it('icon and description are saved; the details are visible to the creator', async () => {
    const res = await post(A, '/projects', {
      name: 'Sprzedaż',
      icon: { type: 'emoji', value: '🚀' },
      description: 'Leady i oferty',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ icon: { type: 'emoji', value: '🚀' }, description: 'Leady i oferty' });
    const details = await get(A, `/projects/${res.body.id}`);
    expect(details.status).toBe(200);
    expect(details.body).toEqual(res.body);
  });

  it.each([
    [{}, 400],
    [{ name: '' }, 400],
    [{ name: '   ' }, 400],
    [{ name: 'x'.repeat(256) }, 400],
    [{ name: 42 }, 400],
    [{ name: 'Ok', description: 'x'.repeat(513) }, 400],
    [{ name: 'Ok', icon: { type: 'image', value: 'x' } }, 400],
    [{ name: 'Ok', icon: { type: 'emoji', value: '' } }, 400],
    [{ name: 'Ok', icon: { type: 'emoji', value: 'x'.repeat(17) } }, 400],
    [{ name: 'Ok', icon: { type: 'emoji', value: '🚀', extra: 1 } }, 400],
    [{ name: 'Ok', type: 'personal' }, 400],
    [{ name: 'Ok', creatorId: randomUUID() }, 400],
    [{ name: 'x'.repeat(255), description: 'x'.repeat(512), icon: null }, 200],
  ])('POST %j → %i', async (body, status) => {
    const res = await post(A, '/projects', body);
    expect(res.status).toBe(status);
    if (status === 400) expect(typeof res.body.message).toBe('string');
  });
});

describe('Review Focus 5: a stranger guessing project ids', () => {
  it("B gets the same 404 for A's project, A's personal project, a random uuid and an invalid id", async () => {
    const project = await createProject(A);
    const random = await get(B, `/projects/${randomUUID()}`);
    expect(random.status).toBe(404);
    expect(random.body).toEqual(NOT_FOUND);

    for (const id of [project.id, A.personalProjectId, 'abc', '123', `${project.id}0`]) {
      const res = await get(B, `/projects/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(random.body);
    }
  });

  it("every write on A's project by B → the same 404, nothing changes", async () => {
    const project = await createProject(A);
    const responses = await Promise.all([
      patch(B, `/projects/${project.id}`, { name: 'Przejęty' }),
      del(B, `/projects/${project.id}`),
      post(B, `/projects/${project.id}/invitations`, { email: B.email, role: 'project:viewer' }),
      patch(B, `/projects/${project.id}/members/${A.id}`, { role: 'project:viewer' }),
      del(B, `/projects/${project.id}/members/${A.id}`),
      del(B, `/projects/${project.id}/members/${B.id}`),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    const details = await get(A, `/projects/${project.id}`);
    expect(details.body).toMatchObject({ name: 'Marketing', memberCount: 1 });
  });

  it('privacy: the global owner (A) has no access to a project they are not a member of', async () => {
    const project = await createProject(B, 'Tajny projekt B');
    for (const res of [
      await get(A, `/projects/${project.id}`),
      await get(A, `/projects/${B.personalProjectId}`),
      await patch(A, `/projects/${project.id}`, { name: 'x' }),
      await del(A, `/projects/${project.id}`),
      await post(A, `/projects/${project.id}/invitations`, { email: A.email, role: 'project:viewer' }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect((await myProjects(A)).map((p) => p.id)).toEqual([A.personalProjectId]);
  });
});

describe('members and roles', () => {
  it('B joins as viewer → B sees it; B cannot edit; A promotes B to editor, never to admin', async () => {
    const project = await createProject(A);
    const joined = await addMember(A, project.id, B, 'project:viewer');
    expect(joined.memberCount).toBe(2);
    expect(roleOf(joined, B)).toBe('project:viewer');

    const theirs = await myProjects(B);
    expect(theirs.find((p) => p.id === project.id)).toMatchObject({ role: 'project:viewer', memberCount: 2 });
    const details = await get(B, `/projects/${project.id}`);
    expect(details.status).toBe(200);
    expect(details.body.role).toBe('project:viewer');
    expect(details.body.members.map((m: { email: string }) => m.email)).toEqual([A.email, B.email]);

    const rename = await patch(B, `/projects/${project.id}`, { name: 'Przejęty' });
    expect(rename.status).toBe(403);
    expect(rename.body).toEqual(FORBIDDEN);
    expect((await del(B, `/projects/${project.id}`)).status).toBe(403);
    expect(
      (await post(B, `/projects/${project.id}/invitations`, { email: C.email, role: 'project:viewer' }))
        .status,
    ).toBe(403);
    expect(
      (await patch(B, `/projects/${project.id}/members/${B.id}`, { role: 'project:admin' })).status,
    ).toBe(403);

    const editor = await patch(A, `/projects/${project.id}/members/${B.id}`, { role: 'project:editor' });
    expect(editor.status).toBe(200);
    expect(roleOf(editor.body, B)).toBe('project:editor');
    // Project settings and members stay admin-only.
    expect((await patch(B, `/projects/${project.id}`, { name: 'Przejęty' })).status).toBe(403);

    // The creator is the project's only owner: nobody else becomes project:admin.
    const admin = await patch(A, `/projects/${project.id}/members/${B.id}`, { role: 'project:admin' });
    expect(admin.status).toBe(400);
    expect(admin.body).toEqual(BAD_MEMBER_ROLE);
    const details2 = await get(A, `/projects/${project.id}`);
    expect(roleOf(details2.body, B)).toBe('project:editor');
    expect((await patch(B, `/projects/${project.id}`, { name: 'Marketing 2027' })).status).toBe(403);

    const viewer = await patch(A, `/projects/${project.id}/members/${B.id}`, { role: 'project:viewer' });
    expect(viewer.status).toBe(200);
    expect(roleOf(viewer.body, B)).toBe('project:viewer');
  });

  it('members are listed owner first, then by role and name', async () => {
    const project = await createProject(B);
    await addMember(B, project.id, C, 'project:viewer');
    const details = await addMember(B, project.id, A, 'project:editor');
    expect(details.members.map((m) => [m.email, m.role])).toEqual([
      [B.email, 'project:admin'],
      [A.email, 'project:editor'],
      [C.email, 'project:viewer'],
    ]);
  });

  it('changing a role: only editor and viewer are assignable, unknown member → 404', async () => {
    const project = await createProject(A);
    await addMember(A, project.id, B, 'project:viewer');
    for (const role of ['project:personalOwner', 'project:admin', 'global:admin']) {
      const res = await patch(A, `/projects/${project.id}/members/${B.id}`, { role });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_MEMBER_ROLE);
    }
    expect((await patch(A, `/projects/${project.id}/members/${B.id}`, {})).status).toBe(400);

    for (const userId of [C.id, randomUUID(), 'abc']) {
      const res = await patch(A, `/projects/${project.id}/members/${userId}`, { role: 'project:editor' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Member not found' });
      expect((await del(A, `/projects/${project.id}/members/${userId}`)).body).toEqual({
        message: 'Member not found',
      });
    }
  });

  it('a viewer may leave; a viewer or editor may not remove others', async () => {
    const project = await createProject(A);
    await addMember(A, project.id, B, 'project:editor');
    await addMember(A, project.id, C, 'project:viewer');

    expect((await del(C, `/projects/${project.id}/members/${B.id}`)).status).toBe(403);
    expect((await del(B, `/projects/${project.id}/members/${C.id}`)).status).toBe(403);

    const leave = await del(C, `/projects/${project.id}/members/${C.id}`);
    expect(leave.status).toBe(200);
    expect((await myProjects(C)).map((p) => p.id)).toEqual([C.personalProjectId]);
    expect((await get(C, `/projects/${project.id}`)).status).toBe(404);

    const removed = await del(A, `/projects/${project.id}/members/${B.id}`);
    expect(removed.status).toBe(200);
    expect((await get(A, `/projects/${project.id}`)).body.memberCount).toBe(1);
  });

  it('ids in the URL are case-insensitive: a viewer leaves with their own id in capitals', async () => {
    const project = await createProject(A);
    await addMember(A, project.id, C, 'project:viewer');
    const upper = project.id.toUpperCase();

    const details = await get(C, `/projects/${upper}`);
    expect(details.status).toBe(200);
    expect(details.body.id).toBe(project.id);

    const leave = await del(C, `/projects/${upper}/members/${C.id.toUpperCase()}`);
    expect(leave.status).toBe(200);
    expect((await myProjects(C)).map((p) => p.id)).toEqual([C.personalProjectId]);
  });
});

describe('Review Focus 4: the owner of a team project can never be removed or demoted', () => {
  async function owners(projectId: string): Promise<string[]> {
    const rows: { userId: string }[] = await dataSource.query(
      `SELECT user_id AS "userId" FROM project_relation WHERE project_id = $1 AND role = 'project:admin'`,
      [projectId],
    );
    return rows.map((row) => row.userId);
  }

  it('the owner cannot demote themselves or leave (409); members cannot touch the owner (403)', async () => {
    const project = await createProject(A);
    await addMember(A, project.id, B, 'project:editor');
    await addMember(A, project.id, C, 'project:viewer');

    for (const role of ['project:editor', 'project:viewer']) {
      const demote = await patch(A, `/projects/${project.id}/members/${A.id}`, { role });
      expect(demote.status).toBe(409);
      expect(demote.body).toEqual(OWNER_PROTECTED);
    }
    const leave = await del(A, `/projects/${project.id}/members/${A.id}`);
    expect(leave.status).toBe(409);
    expect(leave.body).toEqual(OWNER_CANNOT_LEAVE);

    for (const member of [B, C]) {
      const demote = await patch(member, `/projects/${project.id}/members/${A.id}`, {
        role: 'project:viewer',
      });
      expect(demote.status).toBe(403);
      const remove = await del(member, `/projects/${project.id}/members/${A.id}`);
      expect(remove.status).toBe(403);
    }
    expect(await owners(project.id)).toEqual([A.id]);
    const details = await get(A, `/projects/${project.id}`);
    expect(details.body).toMatchObject({ role: 'project:admin', memberCount: 3 });
    expect(details.body.members[0]).toMatchObject({ userId: A.id, role: 'project:admin' });

    // Members (editor or viewer) may still leave.
    expect((await del(B, `/projects/${project.id}/members/${B.id}`)).status).toBe(200);
    expect((await del(C, `/projects/${project.id}/members/${C.id}`)).status).toBe(200);
    expect(await owners(project.id)).toEqual([A.id]);
  });

  it('concurrent attempts to step down, leave and change roles never remove the owner', async () => {
    for (let round = 0; round < 8; round++) {
      const project = await createProject(A, `Wyścig ${round}`);
      await addMember(A, project.id, B, 'project:editor');
      await addMember(A, project.id, C, 'project:viewer');
      const [demote, leave, bLeaves, cRole] = await Promise.all([
        patch(A, `/projects/${project.id}/members/${A.id}`, { role: 'project:viewer' }),
        del(A, `/projects/${project.id}/members/${A.id}`),
        del(B, `/projects/${project.id}/members/${B.id}`),
        patch(A, `/projects/${project.id}/members/${C.id}`, { role: 'project:editor' }),
      ]);
      expect([demote.status, leave.status, bLeaves.status, cRole.status], `round ${round}`).toEqual([
        409, 409, 200, 200,
      ]);
      expect(await owners(project.id), `round ${round}`).toEqual([A.id]);
      await del(A, `/projects/${project.id}`).expect(200);
    }
  });
});

describe('personal projects', () => {
  it('only the icon can change; name and description → 400', async () => {
    const id = A.personalProjectId;
    expect((await patch(A, `/projects/${id}`, { name: 'Inna nazwa' })).status).toBe(400);
    expect((await patch(A, `/projects/${id}`, { description: 'Opis' })).status).toBe(400);
    const icon = await patch(A, `/projects/${id}`, { icon: { type: 'emoji', value: '🏠' } });
    expect(icon.status).toBe(200);
    expect(icon.body).toMatchObject({
      name: 'Anna Adamska <anna@firma.pl>',
      icon: { type: 'emoji', value: '🏠' },
    });
  });

  it('cannot be deleted and its members cannot be changed → 400', async () => {
    const id = A.personalProjectId;
    expect((await del(A, `/projects/${id}`)).status).toBe(400);
    expect(
      (await post(A, `/projects/${id}/invitations`, { email: B.email, role: 'project:viewer' })).status,
    ).toBe(400);
    expect((await patch(A, `/projects/${id}/members/${A.id}`, { role: 'project:admin' })).status).toBe(400);
    expect((await del(A, `/projects/${id}/members/${A.id}`)).status).toBe(400);
    expect((await get(A, `/projects/${id}`)).body).toMatchObject({
      memberCount: 1,
      role: 'project:personalOwner',
    });
  });
});

describe('updating a team project', () => {
  it('name, description and icon can be changed and cleared; unknown fields → 400', async () => {
    const project = await createProject(A);
    const res = await patch(A, `/projects/${project.id}`, {
      name: ' Marketing PL ',
      description: 'Kampanie',
      icon: { type: 'emoji', value: '📣' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Marketing PL',
      description: 'Kampanie',
      icon: { type: 'emoji', value: '📣' },
    });

    const cleared = await patch(A, `/projects/${project.id}`, { description: null, icon: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ name: 'Marketing PL', description: null, icon: null });

    expect((await patch(A, `/projects/${project.id}`, { name: '' })).status).toBe(400);
    expect((await patch(A, `/projects/${project.id}`, { name: null })).status).toBe(400);
    expect((await patch(A, `/projects/${project.id}`, { type: 'personal' })).status).toBe(400);
  });
});

describe('team project limit', () => {
  it('the 4th owned team project with TEAM_PROJECTS_LIMIT=3 → 403; deleting one frees a slot', async () => {
    app = createApp({
      config: testConfig({ TEAM_PROJECTS_LIMIT: '3' }),
      checks: [],
      dataSource,
      mailer,
    });
    for (const name of ['Jeden', 'Dwa', 'Trzy']) await createProject(A, name);
    const fourth = await post(A, '/projects', { name: 'Cztery' });
    expect(fourth.status).toBe(403);
    expect(fourth.body).toEqual({ message: 'Team project limit reached' });
    // Others are not affected, and being an editor of someone else's project does not count.
    const own = await createProject(B, 'B1');
    await addMember(B, own.id, A, 'project:editor');
    expect((await post(B, '/projects', { name: 'B2' })).status).toBe(200);
    expect((await post(A, '/projects', { name: 'Cztery' })).status).toBe(403);

    const first = (await myProjects(A)).find((p) => p.name === 'Jeden');
    await del(A, `/projects/${first?.id}`).expect(200);
    expect((await post(A, '/projects', { name: 'Cztery' })).status).toBe(200);
  });

  it('a per-account limit overrides TEAM_PROJECTS_LIMIT (higher or lower); NULL uses the default', async () => {
    app = createApp({
      config: testConfig({ TEAM_PROJECTS_LIMIT: '3' }),
      checks: [],
      dataSource,
      mailer,
    });
    await dataSource.query(`UPDATE "user" SET team_projects_limit = 5 WHERE id = $1`, [A.id]);
    await dataSource.query(`UPDATE "user" SET team_projects_limit = 1 WHERE id = $1`, [C.id]);

    for (let i = 1; i <= 5; i++) await createProject(A, `A${i}`);
    expect((await post(A, '/projects', { name: 'A6' })).body).toEqual({
      message: 'Team project limit reached',
    });
    // The signed-in user sees the effective limit and the owned count (for "5 of 5" in the UI).
    const me = await request(app).get('/rest/login').set('Cookie', A.cookie);
    expect(me.body).toMatchObject({ teamProjectsLimit: 5, ownedTeamProjects: 5 });
    for (let i = 1; i <= 3; i++) await createProject(B, `B${i}`);
    expect((await post(B, '/projects', { name: 'B4' })).status).toBe(403);
    await createProject(C, 'C1');
    expect((await post(C, '/projects', { name: 'C2' })).status).toBe(403);

    // Back to NULL: the default from the configuration applies again.
    await dataSource.query(`UPDATE "user" SET team_projects_limit = NULL WHERE id = $1`, [C.id]);
    await createProject(C, 'C2');
    await createProject(C, 'C3');
    expect((await post(C, '/projects', { name: 'C4' })).status).toBe(403);
  });

  it('concurrent creates cannot exceed the limit', async () => {
    app = createApp({
      config: testConfig({ TEAM_PROJECTS_LIMIT: '3' }),
      checks: [],
      dataSource,
      mailer,
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(A, '/projects', { name: `Równoległy ${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
  });
});

describe('deleting', () => {
  it('a team project → 200 and it disappears for every member', async () => {
    const project = await createProject(A);
    await addMember(A, project.id, B, 'project:editor');
    await addMember(A, project.id, C, 'project:viewer');
    expect((await del(B, `/projects/${project.id}`)).status).toBe(403);

    const res = await del(A, `/projects/${project.id}`);
    expect(res.status).toBe(200);
    for (const user of [A, B, C]) {
      expect((await myProjects(user)).map((p) => p.id)).toEqual([user.personalProjectId]);
      expect((await get(user, `/projects/${project.id}`)).body).toEqual(NOT_FOUND);
    }
    const relations: unknown[] = await dataSource.query(
      `SELECT 1 FROM project_relation WHERE project_id = $1`,
      [project.id],
    );
    expect(relations).toHaveLength(0);
  });
});

describe('service functions reused by later tasks', () => {
  it('listForUser = my-projects (public API); projectIdsFor (M2+); owned project count and limit (transfer)', async () => {
    const service = createProjectService({
      dataSource,
      config: testConfig(),
      access: createProjectAccess(dataSource),
    });
    const shared = await createProject(A, 'Wspólny');
    await createProject(A, 'Samotny');
    const other = await createProject(C, 'Celiny');
    await addMember(A, shared.id, B, 'project:editor');
    await addMember(C, other.id, B, 'project:viewer');

    expect(await service.listForUser(A.id)).toEqual(await myProjects(A));

    const access = createProjectAccess(dataSource);
    expect((await access.projectIdsFor(B.id)).sort()).toEqual(
      [B.personalProjectId, shared.id, other.id].sort(),
    );
    expect((await access.projectIdsFor(C.id)).sort()).toEqual([C.personalProjectId, other.id].sort());
    expect(await access.projectIdsFor('not-a-uuid')).toEqual([]);

    // Personal projects and memberships as editor/viewer do not count.
    expect(await ownedTeamProjectCount(dataSource.manager, A.id)).toBe(2);
    expect(await ownedTeamProjectCount(dataSource.manager, B.id)).toBe(0);
    expect(await ownedTeamProjectCount(dataSource.manager, C.id)).toBe(1);

    // A blocked project (owner disabled) is not among anyone's project ids, the owner's included.
    await dataSource.query(`UPDATE "user" SET disabled = true WHERE id = $1`, [C.id]);
    expect((await access.projectIdsFor(B.id)).sort()).toEqual([B.personalProjectId, shared.id].sort());
    expect(await access.projectIdsFor(C.id)).toEqual([]);
    expect((await service.listForUser(B.id)).map((p) => p.id)).toEqual([B.personalProjectId, shared.id]);
  });
});

describe("blocked projects: the owner's account is disabled", () => {
  async function setDisabled(user: TestUser, disabled: boolean): Promise<void> {
    // A is the instance owner (first signup), so may disable anyone.
    const res = await patch(A, `/users/${user.id}`, { disabled });
    expect(res.status).toBe(200);
  }

  function publicProjects(key: string) {
    return request(app).get('/api/v1/projects').set('X-API-KEY', key);
  }

  it('members get 404 and lose the project from their lists; enabling the owner restores it; data stays', async () => {
    const project = await createProject(B, 'Bartka');
    await addMember(B, project.id, C, 'project:editor');
    // C's own project in which B (soon disabled) is only a viewer is not affected.
    const own = await createProject(C, 'Celiny');
    await addMember(C, own.id, B, 'project:viewer');
    const keyRes = await post(C, '/api-keys', { label: 'Skrypt' });
    expect(keyRes.status).toBe(200);
    const key: string = keyRes.body.rawKey;
    const before = await get(C, `/projects/${project.id}`);
    expect(before.status).toBe(200);
    const listedBefore = await myProjects(C);
    expect(listedBefore.map((p) => p.id)).toEqual([C.personalProjectId, project.id, own.id]);

    await setDisabled(B, true);

    // Exactly like a project that does not exist (Review Focus 5), also where C's role would give 403.
    const random = await get(C, `/projects/${randomUUID()}`);
    for (const res of [
      await get(C, `/projects/${project.id}`),
      await patch(C, `/projects/${project.id}`, { name: 'Przejęty' }),
      await del(C, `/projects/${project.id}`),
      await post(C, `/projects/${project.id}/invitations`, { email: A.email, role: 'project:viewer' }),
      await get(C, `/projects/${project.id}/invitations`),
      await patch(C, `/projects/${project.id}/members/${C.id}`, { role: 'project:viewer' }),
      await del(C, `/projects/${project.id}/members/${C.id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(random.body);
    }
    expect((await myProjects(C)).map((p) => p.id)).toEqual([C.personalProjectId, own.id]);
    const api = await publicProjects(key);
    expect(api.status).toBe(200);
    expect(api.body.data.map((p: ProjectSummary) => p.id)).toEqual([C.personalProjectId, own.id]);
    const ownDetails = await get(C, `/projects/${own.id}`);
    expect(ownDetails.status).toBe(200);
    expect(ownDetails.body.memberCount).toBe(2);

    // Nothing was deleted.
    const rows: { role: string }[] = await dataSource.query(
      `SELECT r.role FROM project p JOIN project_relation r ON r.project_id = p.id
       WHERE p.id = $1 ORDER BY r.role`,
      [project.id],
    );
    expect(rows.map((row) => row.role)).toEqual(['project:admin', 'project:editor']);

    await setDisabled(B, false);

    const after = await get(C, `/projects/${project.id}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    expect(await myProjects(C)).toEqual(listedBefore);
    expect((await publicProjects(key)).body.data).toEqual(listedBefore);
    expect((await get(B, `/projects/${project.id}`)).body.role).toBe('project:admin');
  });

  it('disabling the owner while members work on the project never fails (no 500)', async () => {
    const D = await signup('daniel@firma.pl', 'Daniel', 'Dudek');
    for (let round = 0; round < 8; round++) {
      const project = await createProject(B, `Blokowany ${round}`);
      await addMember(B, project.id, C, 'project:editor');
      await addMember(B, project.id, D, 'project:viewer');
      const [disabled, ...ops] = await Promise.all([
        patch(A, `/users/${B.id}`, { disabled: true }),
        get(C, `/projects/${project.id}`),
        del(D, `/projects/${project.id}/members/${D.id}`),
        patch(B, `/projects/${project.id}/members/${C.id}`, { role: 'project:viewer' }),
        patch(B, `/projects/${project.id}`, { name: `Nowa nazwa ${round}` }),
        get(C, '/projects/my-projects'),
      ]);
      expect(disabled.status, `round ${round}`).toBe(200);
      for (const res of ops) expect([200, 401, 404], `round ${round}`).toContain(res.status);

      expect((await get(C, `/projects/${project.id}`)).body, `round ${round}`).toEqual(NOT_FOUND);
      const relations: { userId: string; role: string }[] = await dataSource.query(
        `SELECT user_id AS "userId", role FROM project_relation WHERE project_id = $1`,
        [project.id],
      );
      expect(relations.find((r) => r.userId === B.id)?.role, `round ${round}`).toBe('project:admin');
      expect(
        relations.some((r) => r.userId === C.id),
        `round ${round}`,
      ).toBe(true);

      await setDisabled(B, false);
      expect((await get(C, `/projects/${project.id}`)).status, `round ${round}`).toBe(200);
      await del(B, `/projects/${project.id}`).expect(200);
    }
  });
});
