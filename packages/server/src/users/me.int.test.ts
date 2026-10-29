import type express from 'express';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { PASSWORD_POLICY_MESSAGE } from '../crypto/password.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';

const config = testConfig();
let dataSource: DataSource;
let app: express.Express;

const EMAIL = 'jan@firma.pl';
const PASSWORD = 'Haslo123';
const NEW_PASSWORD = 'NoweHaslo456';
const WRONG_PASSWORD = { message: 'Current password is incorrect' };

async function signup(email = EMAIL): Promise<{ id: string; cookie: string; personalProjectId: string }> {
  const res = await request(app)
    .post('/rest/signup')
    .send({ email, firstName: 'Jan', lastName: 'Kowalski', password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return { id: res.body.id, cookie, personalProjectId: res.body.personalProjectId };
}

function login(email: string, password: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/rest/login')
    .send({ email, password, ...extra });
}

/** Logs in (a second device) and returns that session's cookie. */
async function loginCookie(email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await login(email, password);
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

function me(cookie: string) {
  return request(app).get('/rest/login').set('Cookie', cookie);
}

function patch(path: string, cookie: string | undefined, body: Record<string, unknown>) {
  const req = request(app).patch(path);
  return (cookie ? req.set('Cookie', cookie) : req).send(body);
}

async function personalProjectName(projectId: string): Promise<string> {
  const rows: { name: string }[] = await dataSource.query(`SELECT name FROM project WHERE id = $1`, [
    projectId,
  ]);
  return rows[0]?.name ?? '';
}

function totp(secret: string): string {
  return new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
}

/** Turns 2FA on for the session's user; returns the TOTP secret. */
async function enableMfa(cookie: string): Promise<string> {
  const setup = await request(app).post('/rest/mfa/setup').set('Cookie', cookie).send({});
  expect(setup.status).toBe(200);
  const secret: string = setup.body.secret;
  const enable = await request(app)
    .post('/rest/mfa/enable')
    .set('Cookie', cookie)
    .send({ mfaCode: totp(secret) });
  expect(enable.status).toBe(200);
  return secret;
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  // A fresh app per test: fresh in-memory rate-limit counters.
  app = createApp({ config, checks: [], dataSource, mailer: createFakeMailer() });
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe('every /rest/me route requires a session', () => {
  it.each(['/rest/me', '/rest/me/password', '/rest/me/settings'])('%s → 401', async (path) => {
    const res = await patch(path, undefined, {});
    expect(res.status).toBe(401);
  });
});

describe('PATCH /rest/me', () => {
  it('changes the name: visible in GET /rest/login and in the personal project name', async () => {
    const { cookie, personalProjectId } = await signup();
    const res = await patch('/rest/me', cookie, { firstName: '  Anna ', lastName: 'Nowak' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ firstName: 'Anna', lastName: 'Nowak', email: EMAIL });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    const current = await me(cookie);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ firstName: 'Anna', lastName: 'Nowak' });
    expect(await personalProjectName(personalProjectId)).toBe(`Anna Nowak <${EMAIL}>`);
  });

  it('a name change keeps the session (no new cookie needed)', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { lastName: 'Nowak' });
    expect(res.status).toBe(200);
    expect(sessionCookie(res.headers['set-cookie'])).toBeUndefined();
    expect((await me(cookie)).status).toBe(200);
  });

  it('empty body → 200 with the current user, nothing changes', async () => {
    const { cookie, id } = await signup();
    const res = await patch('/rest/me', cookie, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, email: EMAIL, firstName: 'Jan', lastName: 'Kowalski' });
  });

  it('names must be 1–32 characters after trimming', async () => {
    const { cookie } = await signup();
    const blank = await patch('/rest/me', cookie, { firstName: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body).toEqual({ message: 'First name is required' });
    const long = await patch('/rest/me', cookie, { lastName: 'x'.repeat(33) });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ message: 'Last name must be at most 32 characters' });
  });

  it.each([
    ['role', 'global:owner'],
    ['disabled', true],
    ['mfaEnabled', true],
    ['id', '00000000-0000-0000-0000-000000000000'],
    ['passwordHash', 'x'],
  ])('unknown field %s → 400 and nothing changes', async (field, value) => {
    await signup('owner@firma.pl');
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { firstName: 'Anna', [field]: value });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: `Unknown field: ${field}` });
    const current = await me(cookie);
    expect(current.body).toMatchObject({ role: 'global:member', mfaEnabled: false, firstName: 'Jan' });
  });

  it('email change without the current password → 400', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { email: 'nowy@firma.pl' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Current password is required' });
    expect((await me(cookie)).body.email).toBe(EMAIL);
  });

  it('email change with a wrong password → 401 (not the session message)', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { email: 'nowy@firma.pl', currentPassword: 'Zle12345' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(WRONG_PASSWORD);
    // The session itself is fine.
    expect((await me(cookie)).status).toBe(200);
  });

  it('the same email (other case/spaces) is no change and needs no password', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { email: '  JAN@Firma.PL ', firstName: 'Anna' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: EMAIL, firstName: 'Anna' });
    expect(sessionCookie(res.headers['set-cookie'])).toBeUndefined();
    expect((await me(cookie)).status).toBe(200);
  });

  it('email change with the password: new email logs in, old does not; project renamed', async () => {
    const { cookie, personalProjectId } = await signup();
    const res = await patch('/rest/me', cookie, { email: ' Nowy@Firma.PL', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('nowy@firma.pl');

    expect((await login('nowy@firma.pl', PASSWORD)).status).toBe(200);
    const old = await login(EMAIL, PASSWORD);
    expect(old.status).toBe(401);
    expect(await personalProjectName(personalProjectId)).toBe('Jan Kowalski <nowy@firma.pl>');
  });

  it('email change: the response cookie works, the old one (and other devices) are signed out', async () => {
    const { cookie } = await signup();
    const otherDevice = await loginCookie();
    const res = await patch('/rest/me', cookie, { email: 'nowy@firma.pl', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    const fresh = sessionCookie(res.headers['set-cookie']);
    if (!fresh) throw new Error('no new session cookie');

    expect((await me(fresh)).status).toBe(200);
    // The session fingerprint covers the email, so every older session ends (as after a password change).
    expect((await me(cookie)).status).toBe(401);
    expect((await me(otherDevice)).status).toBe(401);
  });

  it('email taken (different case) → 400 Email already in use', async () => {
    await signup('anna@firma.pl');
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { email: 'ANNA@firma.pl', currentPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Email already in use' });
    expect((await me(cookie)).body.email).toBe(EMAIL);
  });

  it('invalid email → 400', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me', cookie, { email: 'nie-email', currentPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Invalid email address' });
  });

  it('with 2FA on, an email change needs the code: none → 400 998, wrong → 400, valid → 200', async () => {
    const { cookie } = await signup();
    const secret = await enableMfa(cookie);
    const body = { email: 'nowy@firma.pl', currentPassword: PASSWORD };

    const missing = await patch('/rest/me', cookie, body);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ code: 998, message: 'MFA required' });

    const valid = totp(secret);
    const wrong = await patch('/rest/me', cookie, {
      ...body,
      mfaCode: valid === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ message: 'Invalid two-factor code' });
    expect((await me(cookie)).body.email).toBe(EMAIL);

    const ok = await patch('/rest/me', cookie, { ...body, mfaCode: valid });
    expect(ok.status).toBe(200);
    expect(ok.body.email).toBe('nowy@firma.pl');
  });

  it('with 2FA on, a name change or the same email needs no code', async () => {
    const { cookie } = await signup();
    await enableMfa(cookie);
    const res = await patch('/rest/me', cookie, { firstName: 'Anna', email: ' JAN@firma.pl' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ firstName: 'Anna', email: EMAIL });
  });

  it('11th wrong current password within a minute → 429', async () => {
    const { cookie } = await signup();
    for (let i = 0; i < 10; i++) {
      const res = await patch('/rest/me', cookie, { email: 'nowy@firma.pl', currentPassword: `Zle${i}1234` });
      expect(res.status).toBe(401);
    }
    const limited = await patch('/rest/me', cookie, { email: 'nowy@firma.pl', currentPassword: PASSWORD });
    expect(limited.status).toBe(429);
    // The limit is shared with the password change.
    const change = await patch('/rest/me/password', cookie, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(change.status).toBe(429);
  });
});

describe('PATCH /rest/me/password', () => {
  it('Review Focus 3: other device → 401 after the change; the response cookie → 200', async () => {
    const { cookie } = await signup();
    const otherDevice = await loginCookie();
    expect((await me(otherDevice)).status).toBe(200);

    const res = await patch('/rest/me/password', cookie, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(EMAIL);
    const fresh = sessionCookie(res.headers['set-cookie']);
    if (!fresh) throw new Error('no new session cookie');

    expect((await me(otherDevice)).status).toBe(401);
    expect((await me(cookie)).status).toBe(401);
    expect((await me(fresh)).status).toBe(200);
    expect((await login(EMAIL, NEW_PASSWORD)).status).toBe(200);
    expect((await login(EMAIL, PASSWORD)).status).toBe(401);
  });

  it('stores a bcrypt hash, never the password', async () => {
    const { cookie, id } = await signup();
    await patch('/rest/me/password', cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const rows: { password_hash: string }[] = await dataSource.query(
      `SELECT password_hash FROM "user" WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.password_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(rows[0]?.password_hash).not.toContain(NEW_PASSWORD);
  });

  it('wrong current password → 401, password unchanged', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me/password', cookie, {
      currentPassword: 'Zle12345',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(WRONG_PASSWORD);
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
    expect((await me(cookie)).status).toBe(200);
  });

  it('missing current password → 400', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me/password', cookie, { newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Current password is required' });
  });

  it('new password against the policy → 400 with the policy message', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me/password', cookie, { currentPassword: PASSWORD, newPassword: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: PASSWORD_POLICY_MESSAGE });
  });

  it('unknown fields → 400', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me/password', cookie, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      role: 'global:owner',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Unknown field: role' });
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
  });

  it('with 2FA on: no code → 400 998, wrong code → 400, valid code → 200', async () => {
    const { cookie } = await signup();
    const secret = await enableMfa(cookie);
    const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD };

    const missing = await patch('/rest/me/password', cookie, body);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ code: 998, message: 'MFA required' });

    const valid = totp(secret);
    const wrong = await patch('/rest/me/password', cookie, {
      ...body,
      mfaCode: valid === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ message: 'Invalid two-factor code' });

    const ok = await patch('/rest/me/password', cookie, { ...body, mfaCode: valid });
    expect(ok.status).toBe(200);
    const fresh = sessionCookie(ok.headers['set-cookie']);
    if (!fresh) throw new Error('no new session cookie');
    expect((await me(fresh)).status).toBe(200);
    expect((await login(EMAIL, NEW_PASSWORD, { mfaCode: totp(secret) })).status).toBe(200);
  });
});

describe('PATCH /rest/me/settings', () => {
  it('sets the theme and keeps other settings keys', async () => {
    const { cookie, id } = await signup();
    await dataSource.query(`UPDATE "user" SET settings = '{"other": 1}'::jsonb WHERE id = $1`, [id]);
    const res = await patch('/rest/me/settings', cookie, { theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ theme: 'dark' });
    expect((await me(cookie)).body.settings).toEqual({ theme: 'dark' });
    const rows: { settings: Record<string, unknown> }[] = await dataSource.query(
      `SELECT settings FROM "user" WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.settings).toEqual({ other: 1, theme: 'dark' });
  });

  it("theme 'neon' → 400", async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me/settings', cookie, { theme: 'neon' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Theme must be system, light or dark' });
    expect((await me(cookie)).body.settings).toEqual({ theme: 'system' });
  });

  it('unknown fields → 400', async () => {
    const { cookie } = await signup();
    const res = await patch('/rest/me/settings', cookie, { theme: 'light', mfaEnabled: false });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Unknown field: mfaEnabled' });
  });
});
