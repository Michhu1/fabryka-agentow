import { randomUUID } from 'node:crypto';
import type { ProjectDetails, ProjectSummary, ProjectTransfer, ProjectTransferInfo } from '@app/shared';
import type express from 'express';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';
import { insertMember, mailedToken } from '../test/projects.js';
import { ownedTeamProjectCount } from './team-project-limit.js';

const config = testConfig({ TEAM_PROJECTS_LIMIT: '3' });
let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const PASSWORD = 'Haslo123';
const DAY = 24 * 60 * 60_000;
const INVALID = { message: 'Invalid transfer token' };
const WRONG_EMAIL = { message: 'This transfer is for a different email address' };
const LIMIT = { message: 'Team project limit reached' };
const NOT_FOUND = { message: 'Project not found' };

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

/** A fresh app (fresh in-memory rate-limit counters); sessions stay valid. */
function freshApp(): void {
  app = createApp({ config, checks: [], dataSource, mailer });
}

async function createProject(user: TestUser, name = 'Marketing'): Promise<ProjectDetails> {
  const res = await post(user, '/projects', { name });
  expect(res.status).toBe(200);
  return res.body;
}

function requestTransfer(owner: TestUser, projectId: string, email: string, extra?: Record<string, unknown>) {
  return post(owner, `/projects/${projectId}/transfer`, { email, currentPassword: PASSWORD, ...extra });
}

/** Asks for a transfer to `email` and returns the token from the mailed link. */
async function transferToken(owner: TestUser, projectId: string, email: string): Promise<string> {
  const res = await requestTransfer(owner, projectId, email);
  expect(res.status).toBe(200);
  return mailedToken(mailer, email, 'project-transfer');
}

function resolve(token: unknown) {
  return request(app).get('/rest/project-transfers/resolve').query({ token });
}
function accept(user: TestUser, token: unknown) {
  return post(user, '/project-transfers/accept', { token });
}

/** Every membership of the project as `{ userId: role }`. */
async function roles(projectId: string): Promise<Record<string, string>> {
  const rows: { userId: string; role: string }[] = await dataSource.query(
    `SELECT user_id AS "userId", role FROM project_relation WHERE project_id = $1`,
    [projectId],
  );
  return Object.fromEntries(rows.map((row) => [row.userId, row.role]));
}

async function owners(projectId: string): Promise<string[]> {
  const all = await roles(projectId);
  return Object.keys(all).filter((id) => all[id] === 'project:admin');
}

async function pendingTransfers(projectId: string): Promise<{ to_email: string }[]> {
  return dataSource.query(`SELECT to_email FROM project_transfer WHERE project_id = $1`, [projectId]);
}

function totp(secret: string): string {
  return new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
}

/** Turns on 2FA for `user` through the real endpoints; returns the TOTP secret. */
async function enableMfa(user: TestUser): Promise<string> {
  const setup = await post(user, '/mfa/setup', {});
  expect(setup.status).toBe(200);
  const secret: string = setup.body.secret;
  expect((await post(user, '/mfa/enable', { mfaCode: totp(secret) })).status).toBe(200);
  return secret;
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  mailer = createFakeMailer();
  freshApp();
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
    ['post', `/rest/projects/${randomUUID()}/transfer`],
    ['get', `/rest/projects/${randomUUID()}/transfer`],
    ['delete', `/rest/projects/${randomUUID()}/transfer`],
    ['post', '/rest/project-transfers/accept'],
  ] as const)('%s %s → 401', async (method, path) => {
    const res = await request(app)[method](path).set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(401);
  });
});

describe('request → mail → resolve → accept', () => {
  it('the recipient becomes the owner, the previous owner an editor; exactly one owner afterwards', async () => {
    const project = await createProject(A);
    await insertMember(dataSource, project.id, C.id, 'project:viewer');
    const res = await requestTransfer(A, project.id, ' BARTEK@Firma.pl ');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['email', 'expiresAt']);
    expect(res.body.email).toBe(B.email);
    expect(Math.abs(Date.parse(res.body.expiresAt) - Date.now() - 7 * DAY)).toBeLessThan(60_000);

    // Nothing changes until the recipient accepts.
    expect(await roles(project.id)).toEqual({ [A.id]: 'project:admin', [C.id]: 'project:viewer' });
    const pending = await get(A, `/projects/${project.id}/transfer`);
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({
      email: B.email,
      expiresAt: res.body.expiresAt,
      createdAt: expect.any(String),
    } satisfies ProjectTransfer);

    const mail = mailer.sent.at(-1);
    expect(mail?.to).toBe(B.email);
    expect(mail?.text).toContain(`${config.editorBaseUrl}/project-transfer?token=`);
    expect(mail?.text).toContain('Marketing');
    expect(mail?.text).toContain('Anna Adamska');
    expect(mail?.text).toContain('7 dni');
    const token = mailedToken(mailer, B.email, 'project-transfer');
    const stored: { token_hash: string }[] = await dataSource.query(
      `SELECT token_hash FROM project_transfer`,
    );
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const resolved = await resolve(token);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({
      email: B.email,
      projectName: 'Marketing',
      fromName: 'Anna Adamska',
      hasAccount: true,
      pendingInvite: false,
    } satisfies ProjectTransferInfo);

    const accepted = await accept(B, token);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({
      id: project.id,
      name: 'Marketing',
      type: 'team',
      icon: null,
      description: null,
      role: 'project:admin',
      memberCount: 3,
    } satisfies ProjectSummary);
    expect(await roles(project.id)).toEqual({
      [A.id]: 'project:editor',
      [B.id]: 'project:admin',
      [C.id]: 'project:viewer',
    });
    expect(await owners(project.id)).toEqual([B.id]);
    expect(await ownedTeamProjectCount(dataSource.manager, A.id)).toBe(0);
    expect(await ownedTeamProjectCount(dataSource.manager, B.id)).toBe(1);
    expect(await pendingTransfers(project.id)).toEqual([]);

    // One-time.
    expect((await accept(B, token)).body).toEqual(INVALID);
    expect((await resolve(token)).body).toEqual(INVALID);

    // The new owner runs the project; the previous one is an editor and may leave like any member.
    expect((await get(B, `/projects/${project.id}/transfer`)).body).toBeNull();
    expect((await patch(A, `/projects/${project.id}`, { name: 'Przejęty' })).status).toBe(403);
    expect((await patch(B, `/projects/${project.id}`, { name: 'Marketing 2027' })).status).toBe(200);
    expect((await del(B, `/projects/${project.id}/members/${B.id}`)).status).toBe(409);
    expect((await del(A, `/projects/${project.id}/members/${A.id}`)).status).toBe(200);
    expect(await owners(project.id)).toEqual([B.id]);
  });

  it('a member of the project can take it over: their role becomes owner', async () => {
    const project = await createProject(A);
    await insertMember(dataSource, project.id, B.id, 'project:viewer');
    const token = await transferToken(A, project.id, B.email);
    expect((await accept(B, token)).status).toBe(200);
    expect(await roles(project.id)).toEqual({ [A.id]: 'project:editor', [B.id]: 'project:admin' });
  });

  it('identical answer and a mail for an address with and without an account', async () => {
    const [first, second] = [await createProject(A, 'Jeden'), await createProject(A, 'Dwa')];
    const existing = await requestTransfer(A, first.id, B.email);
    const unknown = await requestTransfer(A, second.id, 'nikt@firma.pl');
    expect(existing.status).toBe(200);
    expect(unknown.status).toBe(200);
    const shape = (body: Record<string, unknown>) => ({ ...body, email: 'x', expiresAt: 'x' });
    expect(shape(existing.body)).toEqual(shape(unknown.body));
    expect(unknown.body.email).toBe('nikt@firma.pl');
    expect(Object.keys(existing.headers).sort()).toEqual(Object.keys(unknown.headers).sort());

    const [toB, toNobody] = [B.email, 'nikt@firma.pl'].map((to) => mailer.sent.find((m) => m.to === to));
    const normalized = (text = '') => text.replace(/token=[\w-]+/g, 'token=…').replace(/Jeden|Dwa/g, 'P');
    expect(toB?.subject).toBe(toNobody?.subject);
    expect(normalized(toB?.text)).toBe(normalized(toNobody?.text));
    expect(normalized(toB?.html)).toBe(normalized(toNobody?.html));

    const token = mailedToken(mailer, 'nikt@firma.pl', 'project-transfer');
    expect((await resolve(token)).body).toMatchObject({ hasAccount: false, pendingInvite: false });
  });

  it('a recipient still pending on the platform (no password) → pendingInvite; disabled → nothing', async () => {
    const project = await createProject(A);
    const token = await transferToken(A, project.id, C.email);
    await dataSource.query(`UPDATE "user" SET password_hash = NULL WHERE id = $1`, [C.id]);
    expect((await resolve(token)).body).toMatchObject({ hasAccount: false, pendingInvite: true });
    await dataSource.query(`UPDATE "user" SET disabled = true WHERE id = $1`, [C.id]);
    expect((await resolve(token)).body).toMatchObject({ hasAccount: false, pendingInvite: false });
  });

  it('the link works only for the recipient: another account → 403, the transfer stays', async () => {
    const project = await createProject(A);
    const token = await transferToken(A, project.id, B.email);
    for (const other of [C, A]) {
      const res = await accept(other, token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(WRONG_EMAIL);
    }
    expect(await owners(project.id)).toEqual([A.id]);
    expect((await accept(B, token)).status).toBe(200);
  });

  it('expires after 7 days', async () => {
    const project = await createProject(A);
    const token = await transferToken(A, project.id, B.email);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 7 * DAY - 60_000);
    expect((await resolve(token)).status).toBe(200);

    vi.setSystemTime(start + 7 * DAY + 60_000);
    expect((await resolve(token)).body).toEqual(INVALID);
    const [owner, recipient] = [await relogin(A), await relogin(B)];
    const late = await accept(recipient, token);
    expect(late.status).toBe(400);
    expect(late.body).toEqual(INVALID);
    expect(await owners(project.id)).toEqual([A.id]);
    expect((await get(owner, `/projects/${project.id}/transfer`)).body).toBeNull();
  });

  it('bad tokens → 400; session and invitation tokens never work as transfer tokens', async () => {
    const project = await createProject(A);
    await transferToken(A, project.id, B.email);
    await post(A, `/projects/${project.id}/invitations`, { email: B.email, role: 'project:viewer' }).expect(
      200,
    );
    const invitationToken = mailedToken(mailer, B.email, 'project-invitation');
    const sessionToken = B.cookie.slice('moj-n8n-auth='.length);
    for (const token of [invitationToken, sessionToken, 'abc', '', 'x'.repeat(5000), 42, null]) {
      const res = await accept(B, token);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID);
    }
    for (const token of [invitationToken, sessionToken, 'abc', '']) {
      expect((await resolve(token)).body).toEqual(INVALID);
    }
    expect((await request(app).get('/rest/project-transfers/resolve')).body).toEqual(INVALID);
    expect((await post(B, '/project-transfers/accept', { token: 'abc', extra: 1 })).status).toBe(400);
    // And a transfer token is no invitation token.
    const token = mailedToken(mailer, B.email, 'project-transfer');
    expect((await post(B, '/project-invitations/accept', { token })).status).toBe(400);
    expect(await owners(project.id)).toEqual([A.id]);
  });
});

describe('confirming the request', () => {
  it('without 2FA the current password is required: missing → 400, wrong → 401', async () => {
    const project = await createProject(A);
    for (const body of [
      { email: B.email },
      { email: B.email, currentPassword: '' },
      { email: B.email, mfaCode: '123456' },
    ]) {
      const res = await post(A, `/projects/${project.id}/transfer`, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'Current password is required' });
    }
    const wrong = await requestTransfer(A, project.id, B.email, { currentPassword: 'Zle-haslo1' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ message: 'Current password is incorrect' });
    expect(mailer.sent.filter((m) => m.to === B.email)).toEqual([]);
    expect(await pendingTransfers(project.id)).toEqual([]);
    // The session survives a wrong password (it is a form error, not a sign-out).
    expect((await get(A, '/login')).status).toBe(200);
  });

  it('wrong current passwords count towards the shared per-user limit (with PATCH /me/password)', async () => {
    const project = await createProject(A);
    for (let i = 0; i < 5; i++) {
      expect(
        (await patch(A, '/me/password', { currentPassword: 'Zle1', newPassword: 'Nowe-Haslo1' })).status,
      ).toBe(401);
      expect((await requestTransfer(A, project.id, B.email, { currentPassword: 'Zle1' })).status).toBe(401);
    }
    const limited = await requestTransfer(A, project.id, B.email);
    expect(limited.status).toBe(429);
    expect(await pendingTransfers(project.id)).toEqual([]);
  });

  it('with 2FA on, the 2FA code is required (MFA required, code 998), the password alone is not enough', async () => {
    const secret = await enableMfa(A);
    const project = await createProject(A);
    const missing = await requestTransfer(A, project.id, B.email);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ message: 'MFA required', code: 998 });
    const valid = totp(secret);
    const wrongCode = valid === '000000' ? '111111' : '000000';
    const wrong = await post(A, `/projects/${project.id}/transfer`, { email: B.email, mfaCode: wrongCode });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ message: 'Invalid two-factor code' });
    expect(await pendingTransfers(project.id)).toEqual([]);

    const ok = await post(A, `/projects/${project.id}/transfer`, { email: B.email, mfaCode: totp(secret) });
    expect(ok.status).toBe(200);
    expect(await pendingTransfers(project.id)).toEqual([{ to_email: B.email }]);
  });

  it('own address → 400; personal project → 400; members → 403; strangers → 404; bad input → 400', async () => {
    const project = await createProject(A);
    const own = await requestTransfer(A, project.id, 'ANNA@firma.pl');
    expect(own.status).toBe(400);
    expect(own.body).toEqual({ message: 'You already own this project' });

    const personal = await requestTransfer(A, A.personalProjectId, B.email);
    expect(personal.status).toBe(400);
    expect(personal.body).toEqual({ message: 'Personal project cannot be transferred' });

    await insertMember(dataSource, project.id, B.id, 'project:editor');
    await insertMember(dataSource, project.id, C.id, 'project:viewer');
    for (const member of [B, C]) {
      expect((await requestTransfer(member, project.id, member.email)).status).toBe(403);
      expect((await get(member, `/projects/${project.id}/transfer`)).status).toBe(403);
      expect((await del(member, `/projects/${project.id}/transfer`)).status).toBe(403);
    }
    const stranger = await signup('daniel@firma.pl', 'Daniel', 'Dudek');
    for (const res of [
      await requestTransfer(stranger, project.id, stranger.email),
      await get(stranger, `/projects/${project.id}/transfer`),
      await del(stranger, `/projects/${project.id}/transfer`),
      await requestTransfer(stranger, randomUUID(), B.email),
      await requestTransfer(stranger, 'abc', B.email),
      // A stranger's personal project too: the 404 comes before the "personal" 400.
      await requestTransfer(stranger, A.personalProjectId, B.email),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    for (const body of [
      { currentPassword: PASSWORD },
      { email: 'not-an-email', currentPassword: PASSWORD },
      { email: B.email, currentPassword: PASSWORD, role: 'project:admin' },
    ]) {
      expect((await post(A, `/projects/${project.id}/transfer`, body)).status).toBe(400);
    }
    expect(mailer.sent.filter((m) => m.text.includes('project-transfer'))).toEqual([]);
    expect(await pendingTransfers(project.id)).toEqual([]);
  });

  it('transfer requests are limited per acting user: the 11th within 10 minutes → 429', async () => {
    const project = await createProject(A);
    for (let i = 0; i < 10; i++) {
      expect((await requestTransfer(A, project.id, `nikt${i}@firma.pl`)).status).toBe(200);
    }
    const limited = await requestTransfer(A, project.id, B.email);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ message: 'Too many requests' });
    expect(mailer.sent.filter((m) => m.to === B.email)).toEqual([]);
  });

  it('a mail that cannot be sent is logged without the link or the address; the answer is the same', async () => {
    const project = await createProject(A);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mailer.send = async () => {
      throw new Error('SMTP send failed (ECONNECTION)');
    };
    const res = await requestTransfer(A, project.id, B.email);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(B.email);
    const logged = errors.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('ECONNECTION');
    expect(logged).not.toContain(B.email);
    expect(logged).not.toContain('token');
  });
});

describe('cancelling and replacing', () => {
  it('the owner cancels → the link is dead; nothing to cancel → 404', async () => {
    const project = await createProject(A);
    const token = await transferToken(A, project.id, B.email);
    const cancelled = await del(A, `/projects/${project.id}/transfer`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ deleted: true });
    expect((await get(A, `/projects/${project.id}/transfer`)).body).toBeNull();
    const res = await accept(B, token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID);
    expect(await owners(project.id)).toEqual([A.id]);

    const again = await del(A, `/projects/${project.id}/transfer`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ message: 'Transfer not found' });
  });

  it('a second request replaces the first: the old link is dead, the new one works', async () => {
    const project = await createProject(A);
    const toB = await transferToken(A, project.id, B.email);
    const toC = await transferToken(A, project.id, C.email);
    expect((await get(A, `/projects/${project.id}/transfer`)).body).toMatchObject({ email: C.email });
    expect(await pendingTransfers(project.id)).toEqual([{ to_email: C.email }]);
    const old = await accept(B, toB);
    expect(old.status).toBe(400);
    expect(old.body).toEqual(INVALID);
    expect((await accept(C, toC)).status).toBe(200);
    expect(await owners(project.id)).toEqual([C.id]);
  });

  it('a deleted project takes its transfer with it', async () => {
    const project = await createProject(A);
    const token = await transferToken(A, project.id, B.email);
    await del(A, `/projects/${project.id}`).expect(200);
    expect((await accept(B, token)).body).toEqual(INVALID);
    expect(await pendingTransfers(project.id)).toEqual([]);
  });
});

describe('the recipient needs a free slot', () => {
  it('no free slot → 403 with a readable message, the transfer stays; freeing a slot makes it work', async () => {
    const project = await createProject(A);
    const token = await transferToken(A, project.id, B.email);
    const full = await Promise.all(['B1', 'B2', 'B3'].map((name) => createProject(B, name)));

    const res = await accept(B, token);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(LIMIT);
    expect(await owners(project.id)).toEqual([A.id]);
    expect((await get(A, `/projects/${project.id}/transfer`)).body).toMatchObject({ email: B.email });
    expect((await resolve(token)).status).toBe(200);

    await del(B, `/projects/${full[0]?.id}`).expect(200);
    expect((await accept(B, token)).status).toBe(200);
    expect(await ownedTeamProjectCount(dataSource.manager, B.id)).toBe(3);
  });

  it('a per-account limit applies to the transfer too', async () => {
    await dataSource.query(`UPDATE "user" SET team_projects_limit = 0 WHERE id = $1`, [B.id]);
    const project = await createProject(A);
    const token = await transferToken(A, project.id, B.email);
    expect((await accept(B, token)).body).toEqual(LIMIT);
    await dataSource.query(`UPDATE "user" SET team_projects_limit = 1 WHERE id = $1`, [B.id]);
    expect((await accept(B, token)).status).toBe(200);
  });
});

describe("blocked projects: the owner's account is disabled", () => {
  it('the transfer cannot be resolved or accepted; enabling the owner makes it work again', async () => {
    const project = await createProject(B, 'Bartka');
    const token = await transferToken(B, project.id, C.email);
    await patch(A, `/users/${B.id}`, { disabled: true }).expect(200);

    expect((await resolve(token)).body).toEqual(INVALID);
    const res = await accept(C, token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID);
    expect(await roles(project.id)).toEqual({ [B.id]: 'project:admin' });

    await patch(A, `/users/${B.id}`, { disabled: false }).expect(200);
    expect((await accept(C, token)).status).toBe(200);
    expect(await owners(project.id)).toEqual([C.id]);
  });
});

describe('two things at once (never a 500)', () => {
  it('two accepts of one transfer → exactly one 200, one owner', async () => {
    for (let round = 0; round < 6; round++) {
      const project = await createProject(A, `Wyścig ${round}`);
      const token = await transferToken(A, project.id, B.email);
      const results = await Promise.all([accept(B, token), accept(B, token), accept(B, token)]);
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 400, 400]);
      expect(await owners(project.id), `round ${round}`).toEqual([B.id]);
      expect((await roles(project.id))[A.id], `round ${round}`).toBe('project:editor');
      await del(B, `/projects/${project.id}`).expect(200);
    }
  });

  it('two different requests at once → both 200, exactly one pending transfer, its link works', async () => {
    for (let round = 0; round < 6; round++) {
      freshApp();
      const project = await createProject(A, `Wyścig ${round}`);
      const results = await Promise.all([
        requestTransfer(A, project.id, B.email),
        requestTransfer(A, project.id, C.email),
      ]);
      expect(
        results.map((r) => r.status),
        `round ${round}`,
      ).toEqual([200, 200]);
      const pending = await pendingTransfers(project.id);
      expect(pending, `round ${round}`).toHaveLength(1);
      const winner = pending[0]?.to_email === B.email ? B : C;
      const loser = winner === B ? C : B;
      expect((await accept(loser, mailedToken(mailer, loser.email, 'project-transfer'))).status).toBe(400);
      expect((await accept(winner, mailedToken(mailer, winner.email, 'project-transfer'))).status).toBe(200);
      await del(winner, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept vs cancel → either transferred (cancel 403: no longer the owner) or cancelled (accept 400)', async () => {
    for (let round = 0; round < 8; round++) {
      const project = await createProject(A, `Wyścig ${round}`);
      const token = await transferToken(A, project.id, B.email);
      const [accepted, cancelled] = await Promise.all([
        accept(B, token),
        del(A, `/projects/${project.id}/transfer`),
      ]);
      const outcome = [accepted.status, cancelled.status];
      expect(
        [
          [200, 403],
          [400, 200],
        ],
        `round ${round}: ${outcome}`,
      ).toContainEqual(outcome);
      expect(await owners(project.id), `round ${round}`).toEqual([accepted.status === 200 ? B.id : A.id]);
      expect(await pendingTransfers(project.id), `round ${round}`).toEqual([]);
      await del(accepted.status === 200 ? B : A, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept vs a replacing request → either transferred (request 403) or replaced (accept 400)', async () => {
    for (let round = 0; round < 6; round++) {
      freshApp();
      const project = await createProject(A, `Wyścig ${round}`);
      const token = await transferToken(A, project.id, B.email);
      const [accepted, replaced] = await Promise.all([
        accept(B, token),
        requestTransfer(A, project.id, C.email),
      ]);
      const outcome = [accepted.status, replaced.status];
      expect(
        [
          [200, 403],
          [400, 200],
        ],
        `round ${round}: ${outcome}`,
      ).toContainEqual(outcome);
      expect(await owners(project.id), `round ${round}`).toEqual([accepted.status === 200 ? B.id : A.id]);
      expect(await pendingTransfers(project.id), `round ${round}`).toEqual(
        accepted.status === 200 ? [] : [{ to_email: C.email }],
      );
      await del(accepted.status === 200 ? B : A, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept while the recipient creates a project at the limit → never over the limit', async () => {
    for (let round = 0; round < 6; round++) {
      const project = await createProject(A, `Przekazywany ${round}`);
      const token = await transferToken(A, project.id, B.email);
      await createProject(B, `B1 ${round}`);
      await createProject(B, `B2 ${round}`);
      const [accepted, created] = await Promise.all([accept(B, token), post(B, '/projects', { name: 'B3' })]);
      const outcome = [accepted.status, created.status];
      expect(
        [
          [200, 403],
          [403, 200],
        ],
        `round ${round}: ${outcome}`,
      ).toContainEqual(outcome);
      expect(await ownedTeamProjectCount(dataSource.manager, B.id), `round ${round}`).toBe(3);
      expect(await owners(project.id), `round ${round}`).toEqual([accepted.status === 200 ? B.id : A.id]);
      // Clean up: B owns 3 projects whichever way it went.
      const mine: ProjectSummary[] = (await get(B, '/projects/my-projects')).body;
      for (const p of mine.filter((p) => p.role === 'project:admin'))
        await del(B, `/projects/${p.id}`).expect(200);
      if (accepted.status !== 200) await del(A, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept while the owner is being blocked → 200 or 400; a 400 changes nothing', async () => {
    for (let round = 0; round < 8; round++) {
      const project = await createProject(B, `Blokowany ${round}`);
      const token = await transferToken(B, project.id, C.email);
      const [disabled, accepted] = await Promise.all([
        patch(A, `/users/${B.id}`, { disabled: true }),
        accept(C, token),
      ]);
      expect(disabled.status, `round ${round}`).toBe(200);
      expect([200, 400], `round ${round}: ${accepted.status}`).toContain(accepted.status);
      if (accepted.status === 400) {
        expect(await roles(project.id), `round ${round}`).toEqual({ [B.id]: 'project:admin' });
      } else {
        expect(await owners(project.id), `round ${round}`).toEqual([C.id]);
      }
      await patch(A, `/users/${B.id}`, { disabled: false }).expect(200);
      await del(accepted.status === 200 ? C : B, `/projects/${project.id}`).expect(200);
    }
  });

  it('accept while the recipient account is deleted → 200 then 409, or 401 then 200; never ownerless', async () => {
    for (let round = 0; round < 6; round++) {
      freshApp(); // signups are limited per minute
      const D = await signup(`daniel${round}@firma.pl`, 'Daniel', 'Dudek');
      const project = await createProject(A, `Usuwany ${round}`);
      const token = await transferToken(A, project.id, D.email);
      const [accepted, deleted] = await Promise.all([accept(D, token), del(A, `/users/${D.id}`)]);
      const outcome = [accepted.status, deleted.status];
      expect(
        [
          [200, 409],
          [401, 200],
        ],
        `round ${round}: ${outcome}`,
      ).toContainEqual(outcome);
      expect(await owners(project.id), `round ${round}`).toHaveLength(1);
      if (accepted.status === 200) {
        expect(deleted.body, `round ${round}`).toEqual({
          message: 'User owns team projects',
          projectCount: 1,
        });
        await del(D, `/projects/${project.id}`).expect(200);
      } else {
        await del(A, `/projects/${project.id}`).expect(200);
      }
    }
  });
});
