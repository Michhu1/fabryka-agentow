import type { PublicUser } from '@app/shared';
import type express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { PASSWORD_POLICY_MESSAGE } from '../crypto/password.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';

const config = testConfig();
let dataSource: DataSource;
let app: express.Express;

const PASSWORD = 'Haslo123';

function signup(email: string, extra: Record<string, unknown> = {}, target = app) {
  return request(target)
    .post('/rest/signup')
    .send({ email, firstName: 'Jan', lastName: 'Kowalski', password: PASSWORD, ...extra });
}

function login(email: string, password = PASSWORD, target = app) {
  return request(target).post('/rest/login').send({ email, password });
}

/** Signs up and returns the session cookie (`name=value`). */
async function signupCookie(email: string): Promise<string> {
  const res = await signup(email);
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

function me(cookie?: string) {
  const req = request(app).get('/rest/login');
  return cookie ? req.set('Cookie', cookie) : req;
}

function expectNoSecrets(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/passwordHash|password_hash|mfaSecret|mfa_secret|recoveryCodes|\$2[aby]\$/);
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  // A fresh app per test also means fresh in-memory rate-limit counters.
  app = createApp({ config, checks: [], dataSource, mailer: createFakeMailer() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /rest/signup', () => {
  it('creates the owner with a personal project and sets an httpOnly SameSite=Lax cookie', async () => {
    const res = await signup('jan@firma.pl');
    expect(res.status).toBe(200);
    const user = res.body as PublicUser;
    expect(user).toEqual({
      id: expect.any(String),
      email: 'jan@firma.pl',
      firstName: 'Jan',
      lastName: 'Kowalski',
      role: 'global:owner',
      mfaEnabled: false,
      settings: { theme: 'system' },
      personalProjectId: expect.any(String),
      teamProjectsLimit: 3,
      ownedTeamProjects: 0,
    });
    expectNoSecrets(res.body);

    const setCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('moj-n8n-auth='),
    );
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; Max-Age=604800/);
    // http:// editor → no Secure flag (the browser would drop the cookie on plain http).
    expect(setCookie).not.toMatch(/; Secure/i);

    const [project] = await dataSource.query(
      `SELECT p.name, p.type, p.creator_id, r.role FROM project p JOIN project_relation r ON r.project_id = p.id
       WHERE r.user_id = $1`,
      [user.id],
    );
    expect(project).toEqual({
      name: 'Jan Kowalski <jan@firma.pl>',
      type: 'personal',
      creator_id: user.id,
      role: 'project:personalOwner',
    });
    expect(user.personalProjectId).toBeTruthy();
  });

  it('second account becomes a member', async () => {
    await signup('a@firma.pl');
    const res = await signup('b@firma.pl');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('global:member');
  });

  it('Review Focus 1: email differing in case and spaces is the same account', async () => {
    const res = await signup(' Jan@Firma.PL');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('jan@firma.pl');

    const ok = await login('jan@firma.pl');
    expect(ok.status).toBe(200);
    expect((await login('  JAN@FIRMA.pl ')).status).toBe(200);

    const again = await signup('JAN@firma.pl');
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ message: 'Email already in use' });
  });

  it('Review Focus 2: two simultaneous signups on an empty instance → exactly one owner', async () => {
    const results = await Promise.all([signup('a@firma.pl'), signup('b@firma.pl'), signup('c@firma.pl')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const rows: { role: string; n: number }[] = await dataSource.query(
      `SELECT role, count(*)::int AS n FROM "user" GROUP BY role ORDER BY role`,
    );
    expect(rows).toEqual([
      { role: 'global:member', n: 2 },
      { role: 'global:owner', n: 1 },
    ]);
  });

  it('two simultaneous signups with the same email → one account, the other gets 400', async () => {
    const results = await Promise.all([signup('a@firma.pl'), signup(' A@firma.pl')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM "user"`);
    expect(n).toBe(1);
  });

  it('rejects a weak password with the policy message', async () => {
    const res = await signup('jan@firma.pl', { password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: PASSWORD_POLICY_MESSAGE });
  });

  it('validates email and names', async () => {
    expect((await signup('not-an-email')).status).toBe(400);
    expect((await signup(`${'a'.repeat(250)}@x.pl`)).status).toBe(400);
    expect((await signup('a@x.pl', { firstName: '   ' })).status).toBe(400);
    expect((await signup('a@x.pl', { lastName: 'x'.repeat(33) })).status).toBe(400);
    const missing = await request(app).post('/rest/signup').send({ email: 'a@x.pl' });
    expect(missing.status).toBe(400);
    expect(typeof missing.body.message).toBe('string');
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM "user"`);
    expect(n).toBe(0);
  });

  it('rejects unknown fields instead of ignoring them (no self-made owner)', async () => {
    const res = await signup('a@x.pl', { role: 'global:owner' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Unknown field: role' });
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM "user"`);
    expect(n).toBe(0);
  });

  it('trims names', async () => {
    const res = await signup('a@x.pl', { firstName: '  Anna ', lastName: ' Nowak  ' });
    expect(res.body).toMatchObject({ firstName: 'Anna', lastName: 'Nowak' });
  });

  it('SIGNUP_ENABLED=false: the first account (owner) can sign up, later ones get 403', async () => {
    const closed = createApp({
      config: testConfig({ SIGNUP_ENABLED: 'false' }),
      checks: [],
      dataSource,
      mailer: createFakeMailer(),
    });
    const first = await signup('owner@firma.pl', {}, closed);
    expect(first.status).toBe(200);
    expect(first.body.role).toBe('global:owner');

    const second = await signup('b@firma.pl', {}, closed);
    expect(second.status).toBe(403);
    expect(second.body).toEqual({ message: 'Signup is disabled' });
  });

  it('6th signup from one IP within a minute → 429', async () => {
    for (let i = 0; i < 5; i++) expect((await signup(`u${i}@firma.pl`)).status).toBe(200);
    const res = await signup('u5@firma.pl');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: 'Too many requests' });
  });
});

describe('POST /rest/login', () => {
  it('returns the user and a session cookie', async () => {
    await signup('jan@firma.pl');
    const res = await login('jan@firma.pl');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'jan@firma.pl', role: 'global:owner' });
    expectNoSecrets(res.body);
    const cookie = sessionCookie(res.headers['set-cookie']);
    expect(cookie).toBeDefined();
    expect((await me(cookie)).status).toBe(200);
  });

  it('wrong password and unknown email get the same 401', async () => {
    await signup('jan@firma.pl');
    const wrong = await login('jan@firma.pl', 'Zlehaslo1');
    const unknown = await login('nikt@firma.pl');
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ message: 'Wrong username or password' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(sessionCookie(wrong.headers['set-cookie'])).toBeUndefined();
  });

  it('a disabled user cannot log in', async () => {
    await signup('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET disabled = true`);
    const res = await login('jan@firma.pl');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Wrong username or password' });
  });

  it('an invited user without a password cannot log in', async () => {
    await dataSource.query(
      `INSERT INTO "user" (email, first_name, last_name, role) VALUES ('inv@firma.pl', '', '', 'global:member')`,
    );
    const res = await login('inv@firma.pl');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Wrong username or password' });
  });

  it('a user with 2FA enabled and no code gets 401 code 998', async () => {
    await signup('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET mfa_enabled = true`);
    const res = await login('jan@firma.pl');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 998, message: 'MFA required' });
    // A wrong password must not reveal that the account has 2FA.
    expect((await login('jan@firma.pl', 'Zlehaslo1')).body).toEqual({
      message: 'Wrong username or password',
    });
  });

  it('missing fields → 400', async () => {
    const res = await request(app).post('/rest/login').send({ email: 'a@x.pl' });
    expect(res.status).toBe(400);
  });

  it('11th failed login in a minute → 429', async () => {
    await signup('jan@firma.pl');
    for (let i = 0; i < 10; i++) expect((await login('jan@firma.pl', 'Zlehaslo1')).status).toBe(401);
    const res = await login('jan@firma.pl', 'Zlehaslo1');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: 'Too many requests' });
    // The key includes the normalized email: the correct password is blocked too, other accounts are not.
    expect((await login(' JAN@firma.pl')).status).toBe(429);
    expect((await login('inny@firma.pl', 'Zlehaslo1')).status).toBe(401);
  });

  it('successful logins do not count towards the limit', async () => {
    await signup('jan@firma.pl');
    for (let i = 0; i < 12; i++) expect((await login('jan@firma.pl')).status).toBe(200);
  });
});

describe('session', () => {
  it('GET /rest/login returns the current user with a cookie, 401 without', async () => {
    const cookie = await signupCookie('jan@firma.pl');
    const res = await me(cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: 'jan@firma.pl',
      role: 'global:owner',
      settings: { theme: 'system' },
    });
    expectNoSecrets(res.body);

    const anonymous = await me();
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ message: 'Unauthorized' });
  });

  it('logout revokes the token: the same old cookie → 401', async () => {
    const cookie = await signupCookie('jan@firma.pl');
    const out = await request(app).post('/rest/logout').set('Cookie', cookie).send({});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ loggedOut: true });
    const cleared = (out.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('moj-n8n-auth='),
    );
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect((await me(cookie)).status).toBe(401);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM invalid_auth_token`);
    expect(n).toBe(1);
  });

  it('logout purges revoked tokens that have expired anyway', async () => {
    await dataSource.query(
      `INSERT INTO invalid_auth_token (token_hash, expires_at) VALUES ('old', now() - interval '1 minute'),
       ('live', now() + interval '1 day')`,
    );
    const cookie = await signupCookie('jan@firma.pl');
    await request(app).post('/rest/logout').set('Cookie', cookie).send({});
    const rows: { token_hash: string }[] = await dataSource.query(
      `SELECT token_hash FROM invalid_auth_token ORDER BY token_hash`,
    );
    expect(rows.map((r) => r.token_hash)).not.toContain('old');
    expect(rows.map((r) => r.token_hash)).toContain('live');
    expect(rows).toHaveLength(2);
  });

  it('logout without a cookie (or with garbage) still answers 200', async () => {
    expect((await request(app).post('/rest/logout').send({})).status).toBe(200);
    const res = await request(app).post('/rest/logout').set('Cookie', 'moj-n8n-auth=garbage').send({});
    expect(res.status).toBe(200);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM invalid_auth_token`);
    expect(n).toBe(0);
  });

  it('another session of the same user survives a logout', async () => {
    const first = await signupCookie('jan@firma.pl');
    const second = sessionCookie((await login('jan@firma.pl')).headers['set-cookie']);
    await request(app).post('/rest/logout').set('Cookie', first).send({});
    expect((await me(second)).status).toBe(200);
  });

  it('rejects a tampered token and a token signed with another key', async () => {
    const cookie = await signupCookie('jan@firma.pl');
    const token = cookie.slice('moj-n8n-auth='.length);
    const payload = jwt.decode(token) as jwt.JwtPayload;
    expect(Object.keys(payload).sort()).toEqual(['exp', 'h', 'iat', 'jti', 'sub']);

    const forged = jwt.sign({ sub: payload.sub, h: payload.h, jti: 'x' }, 'other-secret', {
      expiresIn: '7d',
    });
    expect((await me(`moj-n8n-auth=${forged}`)).status).toBe(401);
    expect((await me(`moj-n8n-auth=${token.slice(0, -2)}xx`)).status).toBe(401);
    expect((await me('moj-n8n-auth=not-a-jwt')).status).toBe(401);
  });

  it('a password change elsewhere invalidates the session (h mismatch)', async () => {
    const cookie = await signupCookie('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET password_hash = $1`, [
      '$2b$10$differenthashdifferenthashdifferenthashdiffere',
    ]);
    expect((await me(cookie)).status).toBe(401);
  });

  it('a disabled or deleted user is rejected even with a valid cookie', async () => {
    const cookie = await signupCookie('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET disabled = true`);
    expect((await me(cookie)).status).toBe(401);
    await dataSource.query(`DELETE FROM "user"`);
    expect((await me(cookie)).status).toBe(401);
  });

  it('expires after 7 days and is refreshed when less than a day is left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T12:00:00Z');
    vi.setSystemTime(start);
    const cookie = await signupCookie('jan@firma.pl');

    // 5 days later: valid, no refresh needed.
    vi.setSystemTime(new Date(start.getTime() + 5 * 86_400_000));
    const fresh = await me(cookie);
    expect(fresh.status).toBe(200);
    expect(sessionCookie(fresh.headers['set-cookie'])).toBeUndefined();

    // 6.5 days later: valid and a new cookie is issued.
    vi.setSystemTime(new Date(start.getTime() + 6.5 * 86_400_000));
    const refreshed = await me(cookie);
    expect(refreshed.status).toBe(200);
    const renewed = sessionCookie(refreshed.headers['set-cookie']);
    expect(renewed).toBeDefined();
    expect(renewed).not.toBe(cookie);

    // 7 days + 1 minute: the old one is expired, the renewed one still works.
    vi.setSystemTime(new Date(start.getTime() + 7 * 86_400_000 + 60_000));
    expect((await me(cookie)).status).toBe(401);
    expect((await me(renewed)).status).toBe(200);
  });

  it('sets Secure when the editor is served over https', async () => {
    const secure = createApp({
      config: testConfig({ EDITOR_BASE_URL: 'https://app.example.com' }),
      checks: [],
      dataSource,
      mailer: createFakeMailer(),
    });
    const res = await signup('jan@firma.pl', {}, secure);
    const line = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('moj-n8n-auth='),
    );
    expect(line).toMatch(/; Secure/i);
  });
});
