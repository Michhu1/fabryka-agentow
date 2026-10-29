import { randomUUID } from 'node:crypto';
import type { DeleteUserConflict, InstanceUser, UserList } from '@app/shared';
import type express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { deriveKey } from '../crypto/keys.js';
import type { Mailer } from '../mail/mailer.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';
import { insertMember } from '../test/projects.js';

const config = testConfig();
let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const PASSWORD = 'Haslo123';
const FORBIDDEN = { message: 'Forbidden' };
const UNAUTHORIZED = { message: 'Unauthorized' };
const INVALID_INVITATION = { message: 'Invalid invitation token' };
const USER_NOT_FOUND = { message: 'User not found' };
const USER_KEYS = [
  'disabled',
  'email',
  'firstName',
  'id',
  'isPending',
  'lastActiveAt',
  'lastName',
  'mfaEnabled',
  'role',
];

type TestUser = { id: string; email: string; cookie: string; personalProjectId: string };
/** Owner (first signup), and two members; tests promote B to admin where they need one. */
let O: TestUser;
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
function login(email: string, password = PASSWORD) {
  return request(app).post('/rest/login').send({ email, password });
}
function resolveInvite(token: string) {
  return request(app).get('/rest/invitations/resolve').query({ token });
}
function accept(token: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/rest/invitations/accept')
    .send({ token, firstName: 'Nowy', lastName: 'Nowak', password: 'NoweHaslo1', ...body });
}

async function makeAdmin(user: TestUser): Promise<void> {
  const res = await patch(O, `/users/${user.id}/role`, { role: 'global:admin' });
  expect(res.status).toBe(200);
}

/** The token from the invitation link of the last mail sent to `to`. */
function inviteTokenFor(to: string): string {
  const mail = mailer.sent.filter((m) => m.to === to).at(-1);
  if (!mail) throw new Error(`no mail sent to ${to}`);
  const match = /\/accept-invite\?token=([\w.-]+)/.exec(mail.text);
  if (!match?.[1]) throw new Error('no invitation link in the mail');
  return match[1];
}

async function invite(by: TestUser, emails: string[], role = 'global:member') {
  const res = await post(by, '/invitations', { emails, role });
  expect(res.status).toBe(200);
  return res.body as { email: string; status: 'invited' | 'exists' }[];
}

async function listUsers(by: TestUser, query = ''): Promise<UserList> {
  const res = await get(by, `/users${query}`);
  expect(res.status).toBe(200);
  return res.body;
}

const jwtSecret = () => deriveKey(config.encryptionKey, 'auth-jwt');
const signToken = (payload: object, expiresIn = 600) =>
  jwt.sign(payload, jwtSecret(), { algorithm: 'HS256', expiresIn });

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  mailer = createFakeMailer();
  // A fresh app per test: fresh in-memory rate-limit counters.
  app = createApp({ config, checks: [], dataSource, mailer });
  O = await signup('olga@firma.pl', 'Olga', 'Owczarek');
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

describe('GET /rest/users', () => {
  it('is only for the owner and admins', async () => {
    const member = await get(B, '/users');
    expect(member.status).toBe(403);
    expect(member.body).toEqual(FORBIDDEN);
    expect((await request(app).get('/rest/users')).status).toBe(401);

    await makeAdmin(B);
    expect((await get(B, '/users')).status).toBe(200);
  });

  it('lists accounts with exactly the public fields, no secrets and no projects', async () => {
    await dataSource.query(`UPDATE "user" SET mfa_secret = 'secret', mfa_enabled = true WHERE id = $1`, [
      B.id,
    ]);
    await invite(O, ['nowy@firma.pl']);
    const list = await listUsers(O);
    expect(list.count).toBe(4);
    expect(list.items.map((u) => u.email)).toEqual([
      'bartek@firma.pl',
      'celina@firma.pl',
      'nowy@firma.pl',
      'olga@firma.pl',
    ]);
    for (const item of list.items) expect(Object.keys(item).sort()).toEqual(USER_KEYS);
    const raw = JSON.stringify(list);
    for (const forbidden of ['passwordHash', 'password_hash', 'mfaSecret', 'secret', '$2', 'project']) {
      expect(raw).not.toContain(forbidden);
    }
    const byEmail = (email: string) => list.items.find((u) => u.email === email) as InstanceUser;
    expect(byEmail('olga@firma.pl')).toMatchObject({
      role: 'global:owner',
      isPending: false,
      disabled: false,
    });
    expect(byEmail('bartek@firma.pl')).toMatchObject({ mfaEnabled: true, firstName: 'Bartek' });
    expect(byEmail('nowy@firma.pl')).toMatchObject({ isPending: true, lastActiveAt: null });
    // The owner's own requests count as activity (UTC day).
    await vi.waitFor(async () => {
      const again = await listUsers(O);
      const owner = again.items.find((u) => u.id === O.id);
      expect(owner?.lastActiveAt).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  it('searches case-insensitively in email and names, with LIKE wildcards taken literally', async () => {
    expect((await listUsers(O, '?search=FIRMA')).count).toBe(3);
    const byEmail = await listUsers(O, '?search=ARTE');
    expect(byEmail.items.map((u) => u.email)).toEqual(['bartek@firma.pl']);
    const byName = await listUsers(O, '?search=cich');
    expect(byName.items.map((u) => u.email)).toEqual(['celina@firma.pl']);
    expect((await listUsers(O, `?search=${encodeURIComponent('%')}`)).count).toBe(0);
    expect((await listUsers(O, '?search=_')).count).toBe(0);
    expect((await listUsers(O, `?search=${encodeURIComponent('\\')}`)).count).toBe(0);
  });

  it('pages with skip/take and counts all matches', async () => {
    const page = await listUsers(O, '?skip=1&take=1');
    expect(page.count).toBe(3);
    expect(page.items.map((u) => u.email)).toEqual(['celina@firma.pl']);
    expect((await listUsers(O, '?skip=10')).items).toEqual([]);
    for (const query of ['?take=0', '?take=101', '?take=abc', '?skip=-1', '?skip=1.5', '?take=1e2']) {
      const res = await get(O, `/users${query}`);
      expect(res.status, query).toBe(400);
      expect(typeof res.body.message).toBe('string');
    }
    expect((await get(O, '/users?take=100')).status).toBe(200);
  });
});

describe('invitations', () => {
  it('invite → mail → resolve → accept → login; a second accept fails', async () => {
    const results = await invite(O, [' Nowy@Firma.PL ', 'nowy@firma.pl', 'BARTEK@firma.pl']);
    expect(results).toEqual([
      { email: 'nowy@firma.pl', status: 'invited' },
      { email: 'bartek@firma.pl', status: 'exists' },
    ]);
    expect(mailer.sent.map((m) => m.to)).toEqual(['nowy@firma.pl']);
    const mail = mailer.sent[0];
    expect(mail?.text).toContain('Olga Owczarek');
    expect(mail?.text).toContain(`${config.editorBaseUrl}/accept-invite?token=`);

    // Pending: cannot sign in or sign up with that address.
    expect((await login('nowy@firma.pl', 'Cokolwiek1')).status).toBe(401);
    const signupTaken = await request(app)
      .post('/rest/signup')
      .send({ email: 'nowy@firma.pl', firstName: 'X', lastName: 'Y', password: PASSWORD });
    expect(signupTaken.status).toBe(400);
    expect(signupTaken.body).toEqual({ message: 'Email already in use' });

    const token = inviteTokenFor('nowy@firma.pl');
    const resolved = await resolveInvite(token);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ email: 'nowy@firma.pl', inviterName: 'Olga Owczarek' });

    const accepted = await accept(token);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      email: 'nowy@firma.pl',
      firstName: 'Nowy',
      lastName: 'Nowak',
      role: 'global:member',
    });
    expect(JSON.stringify(accepted.body)).not.toContain('$2');
    const cookie = sessionCookie(accepted.headers['set-cookie']);
    expect(cookie).toBeDefined();
    const me = await request(app)
      .get('/rest/login')
      .set('Cookie', cookie ?? '');
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(accepted.body.id);

    const personal = await request(app)
      .get('/rest/projects/personal')
      .set('Cookie', cookie ?? '');
    expect(personal.status).toBe(200);
    expect(personal.body).toMatchObject({
      id: accepted.body.personalProjectId,
      name: 'Nowy Nowak <nowy@firma.pl>',
      role: 'project:personalOwner',
    });

    expect((await login('nowy@firma.pl', 'NoweHaslo1')).status).toBe(200);

    const again = await accept(token, { password: 'InneHaslo2' });
    expect(again.status).toBe(400);
    expect(again.body).toEqual(INVALID_INVITATION);
    expect((await resolveInvite(token)).body).toEqual(INVALID_INVITATION);
    expect((await login('nowy@firma.pl', 'InneHaslo2')).status).toBe(401);
    const listed = (await listUsers(O, '?search=nowy')).items[0];
    expect(listed?.isPending).toBe(false);
  });

  it('the invited role is kept; an admin may invite only members; members may not invite', async () => {
    await invite(O, ['admin2@firma.pl'], 'global:admin');
    const accepted = await accept(inviteTokenFor('admin2@firma.pl'));
    expect(accepted.body.role).toBe('global:admin');

    await makeAdmin(B);
    const asAdmin = await post(B, '/invitations', { emails: ['x@firma.pl'], role: 'global:admin' });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body).toEqual(FORBIDDEN);
    expect(await invite(B, ['x@firma.pl'])).toEqual([{ email: 'x@firma.pl', status: 'invited' }]);

    const asMember = await post(C, '/invitations', { emails: ['y@firma.pl'], role: 'global:member' });
    expect(asMember.status).toBe(403);
    expect(
      (
        await request(app)
          .post('/rest/invitations')
          .send({ emails: ['y@firma.pl'] })
      ).status,
    ).toBe(401);
  });

  it('validates the request', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `u${i}@firma.pl`);
    const bodies: Record<string, unknown>[] = [
      { emails: [], role: 'global:member' },
      { emails: tooMany, role: 'global:member' },
      { emails: ['nie-email'], role: 'global:member' },
      { emails: 'a@firma.pl', role: 'global:member' },
      { emails: ['a@firma.pl'], role: 'global:owner' },
      { emails: ['a@firma.pl'] },
      { emails: ['a@firma.pl'], role: 'global:member', extra: 1 },
    ];
    for (const body of bodies) {
      const res = await post(O, '/invitations', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mailer.sent).toEqual([]);
    expect(
      (await post(O, '/invitations', { emails: tooMany.slice(0, 20), role: 'global:member' })).status,
    ).toBe(200);
  });

  it('inviting a pending account again re-sends the link (role unchanged); a disabled one is skipped', async () => {
    await invite(O, ['nowy@firma.pl'], 'global:admin');
    expect(await invite(O, ['nowy@firma.pl'])).toEqual([{ email: 'nowy@firma.pl', status: 'invited' }]);
    expect(mailer.sent.map((m) => m.to)).toEqual(['nowy@firma.pl', 'nowy@firma.pl']);
    const listed = (await listUsers(O, '?search=nowy')).items[0];
    expect(listed?.role).toBe('global:admin');

    await dataSource.query(`UPDATE "user" SET disabled = true WHERE email = 'nowy@firma.pl'`);
    expect(await invite(O, ['nowy@firma.pl'])).toEqual([{ email: 'nowy@firma.pl', status: 'exists' }]);
    expect(mailer.sent).toHaveLength(2);
  });

  it('a mail that cannot be sent is logged without the link and still reported as invited', async () => {
    const failing: Mailer = { send: async () => Promise.reject(new Error('SMTP down')) };
    app = createApp({ config, checks: [], dataSource, mailer: failing });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await invite(O, ['nowy@firma.pl'])).toEqual([{ email: 'nowy@firma.pl', status: 'invited' }]);
    expect(errors).toHaveBeenCalled();
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toContain('SMTP down');
    expect(logged).not.toContain('nowy@firma.pl');
    expect(logged).not.toContain('token');
    expect(logged).not.toMatch(/eyJ/);
  });

  it('limits invitation requests per inviter', async () => {
    for (let i = 0; i < 10; i++) await invite(O, [`u${i}@firma.pl`]);
    const res = await post(O, '/invitations', { emails: ['u10@firma.pl'], role: 'global:member' });
    expect(res.status).toBe(429);
  });

  it('of two concurrent accepts exactly one wins', async () => {
    await invite(O, ['nowy@firma.pl']);
    const token = inviteTokenFor('nowy@firma.pl');
    const results = await Promise.all([
      accept(token, { password: 'PierwszeHaslo1' }),
      accept(token, { password: 'DrugieHaslo2' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const rows: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS count FROM project_relation r JOIN "user" u ON u.id = r.user_id
       WHERE u.email = 'nowy@firma.pl' AND r.role = 'project:personalOwner'`,
    );
    expect(rows[0]?.count).toBe(1);
    const winner = results[0]?.status === 200 ? 'PierwszeHaslo1' : 'DrugieHaslo2';
    expect((await login('nowy@firma.pl', winner)).status).toBe(200);
  });

  it('a disabled, deleted or expired invitation is invalid; bad input is 400', async () => {
    await invite(O, ['nowy@firma.pl']);
    const token = inviteTokenFor('nowy@firma.pl');
    const start = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(start.getTime() + 8 * 24 * 60 * 60_000));
    expect((await resolveInvite(token)).body).toEqual(INVALID_INVITATION);
    expect((await accept(token)).status).toBe(400);
    vi.useRealTimers();

    expect((await accept(token, { password: 'abc' })).status).toBe(400);
    expect((await accept(token, { firstName: '' })).status).toBe(400);
    expect((await accept(token, { role: 'global:owner' })).status).toBe(400);
    expect((await resolveInvite('')).body).toEqual(INVALID_INVITATION);
    expect((await request(app).get('/rest/invitations/resolve')).status).toBe(400);

    await dataSource.query(`UPDATE "user" SET disabled = true WHERE email = 'nowy@firma.pl'`);
    expect((await resolveInvite(token)).body).toEqual(INVALID_INVITATION);
    const disabled = await accept(token);
    expect(disabled.status).toBe(400);
    expect(disabled.body).toEqual(INVALID_INVITATION);

    await dataSource.query(`DELETE FROM "user" WHERE email = 'nowy@firma.pl'`);
    expect((await resolveInvite(token)).body).toEqual(INVALID_INVITATION);
  });

  it('session, reset and invitation tokens never work as one another', async () => {
    await invite(O, ['nowy@firma.pl']);
    const inviteToken = inviteTokenFor('nowy@firma.pl');
    const { sub, by } = jwt.decode(inviteToken) as { sub: string; by: string };
    expect(by).toBe(O.id);

    // A session token is not an invitation.
    const sessionToken = B.cookie.slice('moj-n8n-auth='.length);
    expect((await resolveInvite(sessionToken)).body).toEqual(INVALID_INVITATION);
    expect((await accept(sessionToken)).status).toBe(400);

    // A reset token is not an invitation.
    await request(app).post('/rest/forgot-password').send({ email: B.email });
    const resetMail = mailer.sent.find((m) => m.to === B.email);
    const resetToken = /\/reset-password\?token=([\w.-]+)/.exec(resetMail?.text ?? '')?.[1] ?? '';
    expect(resetToken).not.toBe('');
    expect((await resolveInvite(resetToken)).body).toEqual(INVALID_INVITATION);
    expect((await accept(resetToken)).status).toBe(400);

    // An invitation is neither a session nor a reset token.
    const asSession = await request(app).get('/rest/login').set('Cookie', `moj-n8n-auth=${inviteToken}`);
    expect(asSession.status).toBe(401);
    expect(asSession.body).toEqual(UNAUTHORIZED);
    const asReset = await request(app).get('/rest/resolve-password-token').query({ token: inviteToken });
    expect(asReset.status).toBe(400);

    // Invitation-shaped tokens carrying claims of the other kinds are refused.
    expect((await resolveInvite(signToken({ sub, inv: true, by }))).status).toBe(200);
    for (const extra of [{ jti: 'x' }, { h: 'x' }, { ph: 'x' }]) {
      expect((await resolveInvite(signToken({ sub, inv: true, by, ...extra }))).status).toBe(400);
    }
    expect((await resolveInvite(signToken({ sub, inv: 'true', by }))).status).toBe(400);
    expect((await resolveInvite(signToken({ sub: 'not-a-uuid', inv: true, by }))).status).toBe(400);
    expect(
      (await resolveInvite(jwt.sign({ sub, inv: true, by }, 'other', { algorithm: 'HS256' }))).status,
    ).toBe(400);
    expect((await resolveInvite(jwt.sign({ sub, inv: true, by }, '', { algorithm: 'none' }))).status).toBe(
      400,
    );
    // Still pending: none of the attempts above accepted it.
    expect((await resolveInvite(inviteToken)).status).toBe(200);
  });
});

describe('PATCH /rest/users/:id/role', () => {
  it('only the owner changes roles; the owner role is never given or taken', async () => {
    const promoted = await patch(O, `/users/${B.id}/role`, { role: 'global:admin' });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ id: B.id, role: 'global:admin' });
    expect(Object.keys(promoted.body).sort()).toEqual(USER_KEYS);

    const byAdmin = await patch(B, `/users/${C.id}/role`, { role: 'global:admin' });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body).toEqual(FORBIDDEN);
    expect((await patch(C, `/users/${B.id}/role`, { role: 'global:member' })).status).toBe(403);

    const self = await patch(O, `/users/${O.id}/role`, { role: 'global:member' });
    expect(self.status).toBe(400);
    expect((await patch(O, `/users/${C.id}/role`, { role: 'global:owner' })).status).toBe(400);
    expect((await patch(O, `/users/${C.id}/role`, { role: 'admin' })).status).toBe(400);

    for (const id of [randomUUID(), 'nie-uuid']) {
      const res = await patch(O, `/users/${id}/role`, { role: 'global:admin' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(USER_NOT_FOUND);
    }

    expect((await patch(O, `/users/${B.id}/role`, { role: 'global:member' })).body.role).toBe(
      'global:member',
    );
    expect((await get(B, '/users')).status).toBe(403);
    const roles: { role: string }[] = await dataSource.query(`SELECT role FROM "user" WHERE id = $1`, [O.id]);
    expect(roles[0]?.role).toBe('global:owner');
  });
});

describe('PATCH /rest/users/:id', () => {
  it('a disabled user is signed out at once and cannot sign in; enabling restores access', async () => {
    const res = await patch(O, `/users/${C.id}`, { disabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: C.id, disabled: true });

    const stale = await get(C, '/login');
    expect(stale.status).toBe(401);
    expect(stale.body).toEqual(UNAUTHORIZED);
    expect((await login(C.email)).status).toBe(401);

    expect((await patch(O, `/users/${C.id}`, { disabled: false })).body.disabled).toBe(false);
    expect((await get(C, '/login')).status).toBe(200);
    expect((await login(C.email)).status).toBe(200);
  });

  it('nobody disables themselves or the owner; only the owner disables admins', async () => {
    expect((await patch(O, `/users/${O.id}`, { disabled: true })).status).toBe(400);
    await makeAdmin(B);
    expect((await patch(B, `/users/${B.id}`, { disabled: true })).status).toBe(400);
    const owner = await patch(B, `/users/${O.id}`, { disabled: true });
    expect(owner.status).toBe(400);

    expect((await patch(B, `/users/${C.id}`, { disabled: true })).status).toBe(200);
    await makeAdmin(C);
    const adminOnAdmin = await patch(B, `/users/${C.id}`, { disabled: false });
    expect(adminOnAdmin.status).toBe(403);
    expect(adminOnAdmin.body).toEqual(FORBIDDEN);
    expect((await patch(O, `/users/${C.id}`, { disabled: false })).status).toBe(200);
    expect((await patch(O, `/users/${B.id}`, { disabled: true })).status).toBe(200);

    expect((await patch(O, `/users/${C.id}`, { disabled: 'yes' })).status).toBe(400);
    expect((await patch(O, `/users/${C.id}`, { disabled: true, role: 'global:owner' })).status).toBe(400);
    expect((await patch(O, `/users/${randomUUID()}`, { disabled: true })).status).toBe(404);
    // A member is refused before any rule about the target is looked at.
    await patch(O, `/users/${C.id}/role`, { role: 'global:member' });
    expect((await patch(C, `/users/${O.id}`, { disabled: true })).status).toBe(403);
    const rows: { disabled: boolean }[] = await dataSource.query(
      `SELECT disabled FROM "user" WHERE id = $1`,
      [O.id],
    );
    expect(rows[0]?.disabled).toBe(false);
  });
});

describe('DELETE /rest/users/:id', () => {
  async function createProject(user: TestUser, name: string): Promise<string> {
    const res = await post(user, '/projects', { name });
    expect(res.status).toBe(200);
    return res.body.id;
  }

  async function projectExists(id: string): Promise<boolean> {
    const rows: unknown[] = await dataSource.query(`SELECT 1 FROM project WHERE id = $1`, [id]);
    return rows.length === 1;
  }

  /** Team projects without an owner: must never exist, whatever runs concurrently. */
  async function ownerlessTeamProjects(): Promise<unknown[]> {
    return dataSource.query(
      `SELECT p.id FROM project p WHERE p.type = 'team' AND NOT EXISTS (
         SELECT 1 FROM project_relation r WHERE r.project_id = p.id AND r.role = 'project:admin'
       )`,
    );
  }

  it('409 with only the number of team projects the user owns (no names, no ids); nothing deleted', async () => {
    const shared = await createProject(C, 'Wspólny');
    const solo = await createProject(C, 'Tylko mój');
    await insertMember(dataSource, shared, B.id, 'project:editor');

    const res = await del(O, `/users/${C.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      message: 'User owns team projects',
      projectCount: 2,
    } satisfies DeleteUserConflict);
    expect(JSON.stringify(res.body)).not.toMatch(/Wspólny|Tylko mój|[0-9a-f]{8}-/);
    // Nothing was deleted.
    expect(await projectExists(solo)).toBe(true);
    expect(await projectExists(shared)).toBe(true);
    expect(await projectExists(C.personalProjectId)).toBe(true);
    expect((await get(C, '/login')).status).toBe(200);

    // Once the projects are gone, the account can be deleted.
    await del(C, `/projects/${solo}`).expect(200);
    expect((await del(O, `/users/${C.id}`)).body).toMatchObject({ projectCount: 1 });
    await del(C, `/projects/${shared}`).expect(200);
    expect((await del(O, `/users/${C.id}`)).status).toBe(200);
  });

  it("deletes the account, its personal project, its memberships in others' projects and its keys", async () => {
    const shared = await createProject(B, 'Bartka');
    await insertMember(dataSource, shared, C.id, 'project:editor');
    const viewed = await createProject(O, 'Olgi');
    await insertMember(dataSource, viewed, C.id, 'project:viewer');
    const apiKeyRows: unknown[] = await dataSource.query(
      `INSERT INTO api_key (user_id, label, key_hash, hint) VALUES ($1, 'k', 'h', 'abcd') RETURNING id`,
      [C.id],
    );
    expect(apiKeyRows).toHaveLength(1);

    const res = await del(O, `/users/${C.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    expect(await projectExists(C.personalProjectId)).toBe(false);
    expect(await projectExists(shared)).toBe(true);
    expect(await projectExists(viewed)).toBe(true);
    const details = await get(B, `/projects/${shared}`);
    expect(details.body.members.map((m: { userId: string }) => m.userId)).toEqual([B.id]);
    const leftovers: unknown[] = await dataSource.query(
      `SELECT 1 FROM "user" WHERE id = $1 UNION ALL SELECT 1 FROM api_key WHERE user_id = $1
       UNION ALL SELECT 1 FROM project_relation WHERE user_id = $1`,
      [C.id],
    );
    expect(leftovers).toEqual([]);
    expect((await get(C, '/login')).status).toBe(401);
    expect((await login(C.email)).status).toBe(401);
    expect((await listUsers(O)).count).toBe(2);
  });

  it('a pending invitation can be deleted (revoked)', async () => {
    await invite(O, ['nowy@firma.pl']);
    const token = inviteTokenFor('nowy@firma.pl');
    const pending = (await listUsers(O, '?search=nowy')).items[0] as InstanceUser;
    expect((await del(O, `/users/${pending.id}`)).status).toBe(200);
    expect((await accept(token)).status).toBe(400);
  });

  it('nobody deletes themselves or the owner; only the owner deletes admins', async () => {
    expect((await del(O, `/users/${O.id}`)).status).toBe(400);
    await makeAdmin(B);
    expect((await del(B, `/users/${O.id}`)).status).toBe(400);
    expect((await del(B, `/users/${B.id}`)).status).toBe(400);
    await makeAdmin(C);
    const adminOnAdmin = await del(B, `/users/${C.id}`);
    expect(adminOnAdmin.status).toBe(403);
    expect(adminOnAdmin.body).toEqual(FORBIDDEN);
    expect((await del(B, `/users/${randomUUID()}`)).body).toEqual(USER_NOT_FOUND);
    expect((await del(B, '/users/nie-uuid')).status).toBe(404);

    await patch(O, `/users/${C.id}/role`, { role: 'global:member' });
    expect((await del(B, `/users/${C.id}`)).status).toBe(200);
    expect((await del(C, `/users/${B.id}`)).status).toBe(401);
  });

  async function freshUsers(): Promise<TestUser> {
    await truncateAll(dataSource);
    app = createApp({ config, checks: [], dataSource, mailer });
    O = await signup('olga@firma.pl', 'Olga', 'Owczarek');
    B = await signup('bartek@firma.pl', 'Bartek', 'Bielski');
    C = await signup('celina@firma.pl', 'Celina', 'Cicha');
    return signup('daniel@firma.pl', 'Daniel', 'Dudek');
  }

  it('changing or removing a member while the account is deleted never fails; the owner stays', async () => {
    for (let round = 0; round < 6; round++) {
      const D = await freshUsers();
      const project = await createProject(B, 'Wspólny');
      await insertMember(dataSource, project, C.id, 'project:editor');
      await insertMember(dataSource, project, D.id, 'project:viewer');

      // Even rounds: the owner removes C while C is deleted; odd rounds: C's role changes meanwhile.
      // Deleting the owner at the same time is always refused.
      const [change, deleted, ownerDeleted] = await Promise.all([
        round % 2 === 0
          ? del(B, `/projects/${project}/members/${C.id}`)
          : patch(B, `/projects/${project}/members/${C.id}`, { role: 'project:viewer' }),
        del(O, `/users/${C.id}`),
        del(O, `/users/${B.id}`),
      ]);
      expect([200, 404], `round ${round}: change ${change.status}`).toContain(change.status);
      expect(deleted.status, `round ${round}`).toBe(200);
      expect(ownerDeleted.status, `round ${round}`).toBe(409);
      expect(ownerDeleted.body, `round ${round}`).toEqual({
        message: 'User owns team projects',
        projectCount: 1,
      });
      const members: { userId: string; role: string }[] = await dataSource.query(
        `SELECT user_id AS "userId", role FROM project_relation WHERE project_id = $1 ORDER BY role`,
        [project],
      );
      expect(members, `round ${round}`).toEqual([
        { userId: B.id, role: 'project:admin' },
        { userId: D.id, role: 'project:viewer' },
      ]);
    }
  });

  it('deleting a user while they create a team project → 409, or the project is never created', async () => {
    for (let round = 0; round < 8; round++) {
      await freshUsers();
      const [created, deleted] = await Promise.all([
        post(C, '/projects', { name: `Nowy ${round}` }),
        del(O, `/users/${C.id}`),
      ]);
      const outcome = [created.status, deleted.status];
      // Either the project came first (and blocks the deletion), or the account was gone first.
      expect(
        [
          [200, 409],
          [401, 200],
        ],
        `round ${round}: ${outcome}`,
      ).toContainEqual(outcome);
      expect(await ownerlessTeamProjects(), `round ${round}`).toEqual([]);
      const projects: { count: number }[] = await dataSource.query(
        `SELECT count(*)::int AS count FROM project WHERE type = 'team'`,
      );
      expect(projects[0]?.count, `round ${round}`).toBe(created.status === 200 ? 1 : 0);
    }
  });

  it('deleting a project while one of its members is deleted never fails (no deadlock)', async () => {
    for (let round = 0; round < 8; round++) {
      const D = await freshUsers();
      // Odd rounds: C created the project and handed it to B (as a transfer will, set up directly here),
      // so deleting C also clears the project's creator (ON DELETE SET NULL) while B deletes it.
      const [creator, owner] = round % 2 === 0 ? [B, B] : [C, B];
      const project = await createProject(creator, 'Wspólny');
      const other = creator === B ? C : B;
      await insertMember(dataSource, project, other.id, 'project:editor');
      await insertMember(dataSource, project, D.id, 'project:editor');
      if (creator !== owner) {
        await dataSource.query(
          `UPDATE project_relation SET role = 'project:editor' WHERE project_id = $1 AND user_id = $2`,
          [project, creator.id],
        );
        await dataSource.query(
          `UPDATE project_relation SET role = 'project:admin' WHERE project_id = $1 AND user_id = $2`,
          [project, owner.id],
        );
      }

      const [projectDeleted, userDeleted] = await Promise.all([
        del(B, `/projects/${project}`),
        del(O, `/users/${C.id}`),
      ]);
      expect([projectDeleted.status, userDeleted.status], `round ${round}`).toEqual([200, 200]);
      expect(await projectExists(project), `round ${round}`).toBe(false);
      const leftovers: unknown[] = await dataSource.query(
        `SELECT 1 FROM project_relation WHERE project_id = $1 OR user_id = $2
         UNION ALL SELECT 1 FROM "user" WHERE id = $2`,
        [project, C.id],
      );
      expect(leftovers, `round ${round}`).toEqual([]);
    }
  });

  it('a member cannot delete anyone', async () => {
    const res = await del(C, `/users/${B.id}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN);
  });
});

describe('last active date', () => {
  it('is set to the current UTC day by an authenticated request, written at most once a day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await dataSource.query(`UPDATE "user" SET last_active_at = '2020-01-01' WHERE id = $1`, [C.id]);
    expect((await get(C, '/login')).status).toBe(200);
    await vi.waitFor(async () => {
      const rows: { day: string }[] = await dataSource.query(
        `SELECT to_char(last_active_at, 'YYYY-MM-DD') AS day FROM "user" WHERE id = $1`,
        [C.id],
      );
      expect(rows[0]?.day).toBe(today);
    });

    // Already today: further requests do not write the row again (its xmin stays the same).
    const before: { xmin: string }[] = await dataSource.query(`SELECT xmin::text FROM "user" WHERE id = $1`, [
      C.id,
    ]);
    // ...and do not even send the UPDATE: the day on the loaded row already matches.
    const queries = vi.spyOn(dataSource, 'query');
    for (let i = 0; i < 3; i++) expect((await get(C, '/login')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queries.mock.calls.filter(([sql]) => String(sql).includes('last_active_at'))).toEqual([]);
    queries.mockRestore();
    const after: { xmin: string }[] = await dataSource.query(`SELECT xmin::text FROM "user" WHERE id = $1`, [
      C.id,
    ]);
    expect(after[0]?.xmin).toBe(before[0]?.xmin);
  });
});
