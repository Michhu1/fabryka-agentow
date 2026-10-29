import { randomUUID } from 'node:crypto';
import type {
  ProjectDetails,
  ProjectInvitation,
  ProjectInvitationInfo,
  ProjectInvitationResult,
  ProjectSummary,
} from '@app/shared';
import type express from 'express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';
import { insertMember, mailedToken } from '../test/projects.js';

const config = testConfig();
let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const PASSWORD = 'Haslo123';
const DAY = 24 * 60 * 60_000;
const INVALID = { message: 'Invalid invitation token' };
const WRONG_EMAIL = { message: 'This invitation is for a different email address' };
const ALREADY_MEMBER = { message: 'User is already a member' };
const NOT_FOUND = { message: 'Project not found' };
const BAD_MEMBER_ROLE = { message: 'Role must be project:editor or project:viewer' };

type TestUser = { id: string; email: string; cookie: string; personalProjectId: string };
/** A is the first signup (instance owner: may disable accounts); B and C are members of the instance. */
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

/** A fresh session (e.g. after the clock was moved past the 7-day session lifetime). */
async function relogin(user: TestUser): Promise<TestUser> {
  const res = await request(app).post('/rest/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return { ...user, cookie };
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

function invite(owner: TestUser, projectId: string, email: string, role = 'project:viewer') {
  return post(owner, `/projects/${projectId}/invitations`, { email, role });
}

/** Invites `email` and returns the token from the mailed link. */
async function invitedToken(owner: TestUser, projectId: string, email: string, role = 'project:viewer') {
  const res = await invite(owner, projectId, email, role);
  expect(res.status).toBe(200);
  return mailedToken(mailer, email.trim().toLowerCase(), 'project-invitation');
}

function resolve(token: unknown) {
  return request(app).get('/rest/project-invitations/resolve').query({ token });
}
function accept(user: TestUser, token: unknown) {
  return post(user, '/project-invitations/accept', { token });
}

async function listInvitations(owner: TestUser, projectId: string): Promise<ProjectInvitation[]> {
  const res = await get(owner, `/projects/${projectId}/invitations`);
  expect(res.status).toBe(200);
  return res.body;
}

async function roleIn(projectId: string, user: TestUser): Promise<string | undefined> {
  const rows: { role: string }[] = await dataSource.query(
    `SELECT role FROM project_relation WHERE project_id = $1 AND user_id = $2`,
    [projectId, user.id],
  );
  return rows[0]?.role;
}

async function invitationCount(): Promise<number> {
  const rows: { count: number }[] = await dataSource.query(
    `SELECT count(*)::int AS count FROM project_invitation`,
  );
  return rows[0]?.count ?? 0;
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  mailer = createFakeMailer();
  // A fresh app per test: fresh in-memory rate-limit counters.
  app = createApp({ config, checks: [], dataSource, mailer });
  A = await signup('anna@firma.pl', 'Anna', 'Adamska');
  B = await signup('bartek@firma.pl', 'Bartek', 'Bielski');
  C = await signup('celina@firma.pl', 'Celina', 'Cicha');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe('session required', () => {
  it.each([
    ['get', `/rest/projects/${randomUUID()}/invitations`],
    ['post', `/rest/projects/${randomUUID()}/invitations`],
    ['delete', `/rest/projects/${randomUUID()}/invitations/${randomUUID()}`],
    ['post', '/rest/project-invitations/accept'],
  ] as const)('%s %s → 401', async (method, path) => {
    const res = await request(app)[method](path).set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(401);
  });

  it('the old direct add (POST /rest/projects/:id/members) is gone', async () => {
    const project = await createProject(A);
    const res = await post(A, `/projects/${project.id}/members`, { email: B.email, role: 'project:viewer' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Not found' });
    expect(await roleIn(project.id, B)).toBeUndefined();
  });
});

describe('invite → mail → resolve → accept', () => {
  it('the invited person joins with the invited role only after accepting; the link works once', async () => {
    const project = await createProject(A);
    const res = await invite(A, project.id, '  BARTEK@Firma.PL ', 'project:editor');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: 'bartek@firma.pl',
      status: 'invited',
    } satisfies ProjectInvitationResult);

    // Nothing changes before the invited person accepts.
    expect(await roleIn(project.id, B)).toBeUndefined();
    expect((await get(B, `/projects/${project.id}`)).status).toBe(404);

    const mail = mailer.sent.at(-1);
    expect(mail?.to).toBe('bartek@firma.pl');
    expect(mail?.text).toContain(`${config.editorBaseUrl}/project-invitation?token=`);
    expect(mail?.text).toContain('Marketing');
    expect(mail?.text).toContain('Anna Adamska');
    expect(mail?.text).toContain('7 dni');
    const token = mailedToken(mailer, B.email, 'project-invitation');
    // Only a hash of the token is stored.
    const stored: { token_hash: string }[] = await dataSource.query(
      `SELECT token_hash FROM project_invitation`,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.token_hash).not.toContain(token);

    const resolved = await resolve(token);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({
      email: 'bartek@firma.pl',
      projectName: 'Marketing',
      inviterName: 'Anna Adamska',
      role: 'project:editor',
      hasAccount: true,
      pendingInvite: false,
    } satisfies ProjectInvitationInfo);

    const accepted = await accept(B, token);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({
      id: project.id,
      name: 'Marketing',
      type: 'team',
      icon: null,
      description: null,
      role: 'project:editor',
      memberCount: 2,
    } satisfies ProjectSummary);
    expect(await roleIn(project.id, B)).toBe('project:editor');
    const mine: ProjectSummary[] = (await get(B, '/projects/my-projects')).body;
    expect(mine.map((p) => p.id)).toEqual([B.personalProjectId, project.id]);
    expect(await listInvitations(A, project.id)).toEqual([]);

    // One-time: the used link is dead.
    const again = await accept(B, token);
    expect(again.status).toBe(400);
    expect(again.body).toEqual(INVALID);
    expect((await resolve(token)).body).toEqual(INVALID);
  });

  it('identical answer and a mail for an address with and without an account', async () => {
    const project = await createProject(A);
    const existing = await invite(A, project.id, B.email);
    const unknown = await invite(A, project.id, 'nikt@firma.pl');
    expect(existing.status).toBe(unknown.status);
    expect(existing.body).toEqual({ email: B.email, status: 'invited' });
    expect(unknown.body).toEqual({ email: 'nikt@firma.pl', status: 'invited' });
    expect({ ...existing.body, email: 'x' }).toEqual({ ...unknown.body, email: 'x' });
    expect(Object.keys(existing.headers).sort()).toEqual(Object.keys(unknown.headers).sort());

    // Both get a mail, with the same text apart from the link.
    const [toB, toNobody] = [B.email, 'nikt@firma.pl'].map((to) => mailer.sent.find((m) => m.to === to));
    expect(toB).toBeDefined();
    expect(toNobody).toBeDefined();
    const withoutLink = (text = '') => text.replace(/token=[\w-]+/g, 'token=…');
    expect(toB?.subject).toBe(toNobody?.subject);
    expect(withoutLink(toB?.text)).toBe(withoutLink(toNobody?.text));
    expect(withoutLink(toB?.html)).toBe(withoutLink(toNobody?.html));

    // Only the holder of the link learns whether to sign in or sign up.
    const token = mailedToken(mailer, 'nikt@firma.pl', 'project-invitation');
    expect((await resolve(token)).body).toMatchObject({
      email: 'nikt@firma.pl',
      hasAccount: false,
      pendingInvite: false,
    });
    // A newcomer signs up with the invited address and then accepts.
    const newcomer = await signup('nikt@firma.pl', 'Nowy', 'Nowak');
    expect((await resolve(token)).body).toMatchObject({ hasAccount: true });
    expect((await accept(newcomer, token)).status).toBe(200);
    expect(await roleIn(project.id, newcomer)).toBe('project:viewer');
  });

  it('a disabled account or one still pending (no password) counts as no account', async () => {
    const project = await createProject(A);
    const token = await invitedToken(A, project.id, C.email);
    expect((await resolve(token)).body).toMatchObject({ hasAccount: true, pendingInvite: false });
    // Disabled: looks exactly like an address without an account.
    await dataSource.query(`UPDATE "user" SET disabled = true WHERE id = $1`, [C.id]);
    expect((await resolve(token)).body).toMatchObject({ hasAccount: false, pendingInvite: false });
    // Pending (invited to the platform, never set a password): signing up would fail, so the page
    // tells the holder to accept the platform invitation first.
    await dataSource.query(`UPDATE "user" SET disabled = false, password_hash = NULL WHERE id = $1`, [C.id]);
    expect((await resolve(token)).body).toMatchObject({ hasAccount: false, pendingInvite: true });
    // Pending and disabled: nothing is revealed.
    await dataSource.query(`UPDATE "user" SET disabled = true WHERE id = $1`, [C.id]);
    expect((await resolve(token)).body).toMatchObject({ hasAccount: false, pendingInvite: false });
  });

  it('the link works only for the invited address: another account → 403, the invitation stays', async () => {
    const project = await createProject(A);
    const token = await invitedToken(A, project.id, B.email);
    const other = await accept(C, token);
    expect(other.status).toBe(403);
    expect(other.body).toEqual(WRONG_EMAIL);
    expect(await roleIn(project.id, C)).toBeUndefined();
    // The owner too.
    expect((await accept(A, token)).body).toEqual(WRONG_EMAIL);

    expect((await accept(B, token)).status).toBe(200);
  });

  it('expires after 7 days', async () => {
    const project = await createProject(A);
    const token = await invitedToken(A, project.id, B.email);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(start + 7 * DAY - 60_000);
    expect((await resolve(token)).status).toBe(200);

    vi.setSystemTime(start + 7 * DAY + 60_000);
    expect((await resolve(token)).body).toEqual(INVALID);
    // Sessions last 7 days too: sign in again at the new time.
    const [owner, invited] = [await relogin(A), await relogin(B)];
    const late = await accept(invited, token);
    expect(late.status).toBe(400);
    expect(late.body).toEqual(INVALID);
    expect(await roleIn(project.id, B)).toBeUndefined();
    // The owner no longer sees it as pending.
    expect(await listInvitations(owner, project.id)).toEqual([]);
  });

  it('already a member when accepting → 409 and the invitation is used up', async () => {
    const project = await createProject(A);
    const token = await invitedToken(A, project.id, B.email);
    await insertMember(dataSource, project.id, B.id, 'project:editor');
    const res = await accept(B, token);
    expect(res.status).toBe(409);
    // The id lets the page offer "Przejdź do projektu" (the caller is a member, so it is theirs to see).
    expect(res.body).toEqual({ ...ALREADY_MEMBER, projectId: project.id });
    expect(await roleIn(project.id, B)).toBe('project:editor');
    expect(await invitationCount()).toBe(0);
  });

  it('bad tokens → 400 Invalid invitation token; other kinds of tokens never work as one', async () => {
    const project = await createProject(A);
    await invitedToken(A, project.id, B.email);
    const sessionToken = B.cookie.slice('moj-n8n-auth='.length);
    // A global invitation link (a signed JWT) is not a project invitation either.
    await post(A, '/invitations', { emails: ['nowy@firma.pl'], role: 'global:member' }).expect(200);
    const globalToken = /accept-invite\?token=([\w.-]+)/.exec(mailer.sent.at(-1)?.text ?? '')?.[1];
    expect(globalToken).toBeDefined();
    for (const token of [sessionToken, globalToken, 'abc', '', 'x'.repeat(5000), 42, null, { a: 1 }]) {
      const res = await accept(B, token);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID);
    }
    for (const token of [sessionToken, globalToken, 'abc', '', 'x'.repeat(5000)]) {
      expect((await resolve(token)).body).toEqual(INVALID);
    }
    expect((await request(app).get('/rest/project-invitations/resolve')).body).toEqual(INVALID);
    expect((await post(B, '/project-invitations/accept', {})).body).toEqual(INVALID);
    expect((await post(B, '/project-invitations/accept', { token: 'abc', role: 'x' })).status).toBe(400);
    // And a project invitation token is no global invitation token.
    const token = mailedToken(mailer, B.email, 'project-invitation');
    expect((await request(app).get('/rest/invitations/resolve').query({ token })).status).toBe(400);
    expect((await resolve(token)).status).toBe(200);
  });

  it('a deleted project takes its invitations with it', async () => {
    const project = await createProject(A);
    const token = await invitedToken(A, project.id, B.email);
    await del(A, `/projects/${project.id}`).expect(200);
    expect((await resolve(token)).body).toEqual(INVALID);
    expect((await accept(B, token)).body).toEqual(INVALID);
    expect(await invitationCount()).toBe(0);
  });
});

describe('the owner manages invitations', () => {
  it('only the owner invites, lists and cancels; members get 403, strangers 404', async () => {
    const project = await createProject(A);
    await insertMember(dataSource, project.id, B.id, 'project:editor');
    await insertMember(dataSource, project.id, C.id, 'project:viewer');
    await invitedToken(A, project.id, 'nowy@firma.pl');
    const [pending] = await listInvitations(A, project.id);
    for (const member of [B, C]) {
      expect((await invite(member, project.id, 'inny@firma.pl')).status).toBe(403);
      expect((await get(member, `/projects/${project.id}/invitations`)).status).toBe(403);
      expect((await del(member, `/projects/${project.id}/invitations/${pending?.id}`)).status).toBe(403);
    }
    const stranger = await signup('daniel@firma.pl', 'Daniel', 'Dudek');
    for (const res of [
      await invite(stranger, project.id, 'inny@firma.pl'),
      await get(stranger, `/projects/${project.id}/invitations`),
      await del(stranger, `/projects/${project.id}/invitations/${pending?.id}`),
      await invite(stranger, randomUUID(), 'inny@firma.pl'),
      await invite(stranger, 'abc', 'inny@firma.pl'),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect(await listInvitations(A, project.id)).toHaveLength(1);
    expect(mailer.sent.filter((m) => m.to === 'inny@firma.pl')).toEqual([]);
  });

  it('lists pending invitations; cancelling one kills its link', async () => {
    const project = await createProject(A);
    const tokenB = await invitedToken(A, project.id, B.email, 'project:editor');
    await invitedToken(A, project.id, 'nikt@firma.pl');
    const list = await listInvitations(A, project.id);
    expect(list.map((i) => [i.email, i.role])).toEqual([
      [B.email, 'project:editor'],
      ['nikt@firma.pl', 'project:viewer'],
    ]);
    const first = list[0] as ProjectInvitation;
    expect(Object.keys(first).sort()).toEqual(['createdAt', 'email', 'expiresAt', 'id', 'role']);
    const validFor = Date.parse(first.expiresAt) - Date.parse(first.createdAt);
    expect(Math.abs(validFor - 7 * DAY)).toBeLessThan(60_000);

    const cancelled = await del(A, `/projects/${project.id}/invitations/${first.id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ deleted: true });
    const res = await accept(B, tokenB);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID);
    expect(await roleIn(project.id, B)).toBeUndefined();
    expect((await listInvitations(A, project.id)).map((i) => i.email)).toEqual(['nikt@firma.pl']);

    for (const id of [first.id, randomUUID(), 'abc']) {
      const again = await del(A, `/projects/${project.id}/invitations/${id}`);
      expect(again.status).toBe(404);
      expect(again.body).toEqual({ message: 'Invitation not found' });
    }
    // An invitation of another project cannot be cancelled through this one.
    const other = await createProject(A, 'Inny');
    const [remaining] = await listInvitations(A, project.id);
    expect((await del(A, `/projects/${other.id}/invitations/${remaining?.id}`)).status).toBe(404);
    expect(await listInvitations(A, project.id)).toHaveLength(1);
  });

  it('inviting again replaces the link, the role and the expiry (one invitation per address)', async () => {
    const project = await createProject(A);
    const old = await invitedToken(A, project.id, B.email, 'project:viewer');
    const fresh = await invitedToken(A, project.id, 'Bartek@Firma.pl', 'project:editor');
    expect(fresh).not.toBe(old);
    expect(await listInvitations(A, project.id)).toHaveLength(1);
    expect((await accept(B, old)).body).toEqual(INVALID);
    expect((await accept(B, fresh)).body).toMatchObject({ role: 'project:editor' });
  });

  it('a member (in any case of the address) or the owner themselves → 409; bad input → 400', async () => {
    const project = await createProject(A);
    await insertMember(dataSource, project.id, B.id, 'project:viewer');
    for (const email of ['BARTEK@firma.pl', A.email]) {
      const res = await invite(A, project.id, email);
      expect(res.status).toBe(409);
      expect(res.body).toEqual(ALREADY_MEMBER);
    }
    for (const role of ['project:admin', 'project:personalOwner', 'global:owner']) {
      const res = await invite(A, project.id, C.email, role);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_MEMBER_ROLE);
    }
    for (const body of [
      { email: C.email },
      { role: 'project:viewer' },
      { email: 'not-an-email', role: 'project:viewer' },
      { email: C.email, role: 'project:viewer', userId: C.id },
    ]) {
      expect((await post(A, `/projects/${project.id}/invitations`, body)).status).toBe(400);
    }
    expect(mailer.sent).toEqual([]);
    expect(await invitationCount()).toBe(0);
  });

  it('personal projects take no invitations → 400', async () => {
    const res = await invite(A, A.personalProjectId, B.email);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Members of a personal project cannot be changed' });
    expect(mailer.sent).toEqual([]);
  });

  it('invitations are limited per acting user: the 31st within 10 minutes → 429', async () => {
    const project = await createProject(A);
    for (let i = 0; i < 30; i++) {
      expect((await invite(A, project.id, `nikt${i}@firma.pl`)).status).toBe(200);
    }
    const limited = await invite(A, project.id, B.email);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ message: 'Too many requests' });
    expect(mailer.sent.filter((m) => m.to === B.email)).toEqual([]);
    // Other users have their own counter.
    const own = await createProject(B, 'Bartka');
    expect((await invite(B, own.id, C.email)).status).toBe(200);
  });

  it('a mail that cannot be sent is logged without the link or the address; the answer is the same', async () => {
    const project = await createProject(A);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mailer.send = async () => {
      throw new Error('SMTP send failed (ECONNECTION)');
    };
    const res = await invite(A, project.id, B.email);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: B.email, status: 'invited' });
    const logged = errors.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('ECONNECTION');
    expect(logged).not.toContain(B.email);
    expect(logged).not.toContain('token');
    expect(await listInvitations(A, project.id)).toHaveLength(1);
  });
});

describe("blocked projects: the owner's account is disabled", () => {
  it('the invitation cannot be resolved or accepted; enabling the owner makes it work again', async () => {
    const project = await createProject(B, 'Bartka');
    const token = await invitedToken(B, project.id, C.email, 'project:editor');
    await patch(A, `/users/${B.id}`, { disabled: true }).expect(200);

    expect((await resolve(token)).body).toEqual(INVALID);
    const res = await accept(C, token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID);
    expect(await roleIn(project.id, C)).toBeUndefined();

    await patch(A, `/users/${B.id}`, { disabled: false }).expect(200);
    expect((await accept(C, token)).body).toMatchObject({ id: project.id, role: 'project:editor' });
  });
});

describe('two things at once', () => {
  it('two accepts of one invitation → exactly one 200, one membership', async () => {
    for (let round = 0; round < 6; round++) {
      const project = await createProject(A, `Wyścig ${round}`);
      const token = await invitedToken(A, project.id, B.email);
      const results = await Promise.all([accept(B, token), accept(B, token), accept(B, token)]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 400, 400]);
      const rows: unknown[] = await dataSource.query(
        `SELECT 1 FROM project_relation WHERE project_id = $1 AND user_id = $2`,
        [project.id, B.id],
      );
      expect(rows, `round ${round}`).toHaveLength(1);
      await del(A, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept vs cancel → either joined (cancel 404) or cancelled (accept 400), never 500', async () => {
    for (let round = 0; round < 8; round++) {
      const project = await createProject(A, `Wyścig ${round}`);
      const token = await invitedToken(A, project.id, B.email);
      const [pending] = await listInvitations(A, project.id);
      const [accepted, cancelled] = await Promise.all([
        accept(B, token),
        del(A, `/projects/${project.id}/invitations/${pending?.id}`),
      ]);
      const outcome = [accepted.status, cancelled.status];
      expect(
        [
          [200, 404],
          [400, 200],
        ],
        `round ${round}: ${outcome}`,
      ).toContainEqual(outcome);
      expect(await roleIn(project.id, B), `round ${round}`).toBe(
        accepted.status === 200 ? 'project:viewer' : undefined,
      );
      expect(await invitationCount(), `round ${round}`).toBe(0);
      await del(A, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept while the project is deleted → 200 or 400, never 500; no memberships left', async () => {
    for (let round = 0; round < 8; round++) {
      const project = await createProject(A, `Usuwany ${round}`);
      const token = await invitedToken(A, project.id, B.email);
      const [accepted, deleted] = await Promise.all([accept(B, token), del(A, `/projects/${project.id}`)]);
      expect([200, 400, 404], `round ${round}: ${accepted.status}`).toContain(accepted.status);
      expect(deleted.status, `round ${round}`).toBe(200);
      const left: unknown[] = await dataSource.query(`SELECT 1 FROM project_relation WHERE project_id = $1`, [
        project.id,
      ]);
      expect(left, `round ${round}`).toHaveLength(0);
    }
  });

  it('accept while the owner is being blocked → 200 or 400, never 500; a 400 creates no membership', async () => {
    for (let round = 0; round < 8; round++) {
      const project = await createProject(B, `Blokowany ${round}`);
      const token = await invitedToken(B, project.id, C.email);
      const [disabled, accepted] = await Promise.all([
        patch(A, `/users/${B.id}`, { disabled: true }),
        accept(C, token),
      ]);
      expect(disabled.status, `round ${round}`).toBe(200);
      expect([200, 400], `round ${round}: ${accepted.status}`).toContain(accepted.status);
      if (accepted.status === 400) expect(await roleIn(project.id, C), `round ${round}`).toBeUndefined();
      // Blocked from now on, whoever won.
      expect((await get(C, `/projects/${project.id}`)).status, `round ${round}`).toBe(404);
      await patch(A, `/users/${B.id}`, { disabled: false }).expect(200);
      await del(B, `/projects/${project.id}`).expect(200);
    }
  });

  it('two invitations of one address at once → one pending invitation, never 500', async () => {
    for (let round = 0; round < 6; round++) {
      const project = await createProject(A, `Wyścig ${round}`);
      const results = await Promise.all([
        invite(A, project.id, B.email, 'project:viewer'),
        invite(A, project.id, B.email, 'project:editor'),
      ]);
      expect(
        results.map((r) => r.status),
        `round ${round}`,
      ).toEqual([200, 200]);
      expect(await listInvitations(A, project.id), `round ${round}`).toHaveLength(1);
      // Of the two mailed links, only the one stored last works.
      const tokens = mailer.sent
        .filter((m) => m.to === B.email)
        .slice(-2)
        .map((m) => /token=([\w-]+)/.exec(m.text)?.[1]);
      const resolved = await Promise.all(tokens.map((t) => resolve(t)));
      expect(resolved.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 400]);
      await del(A, `/projects/${project.id}`).expect(200);
    }
  });
});
