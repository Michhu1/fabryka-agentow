import type express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { deriveKey } from '../crypto/keys.js';
import { PASSWORD_POLICY_MESSAGE } from '../crypto/password.js';
import type { Mailer } from '../mail/mailer.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';

const config = testConfig();
let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const PASSWORD = 'Haslo123';
const NEW_PASSWORD = 'NoweHaslo456';
const INVALID_TOKEN = { message: 'Invalid password reset token' };

async function signup(email: string): Promise<{ id: string; cookie: string }> {
  const res = await request(app)
    .post('/rest/signup')
    .send({ email, firstName: 'Jan', lastName: 'Kowalski', password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return { id: res.body.id, cookie };
}

function forgot(email: unknown, target = app) {
  return request(target).post('/rest/forgot-password').send({ email });
}

function resolve(token: string) {
  return request(app).get('/rest/resolve-password-token').query({ token });
}

function change(body: Record<string, unknown>) {
  return request(app).post('/rest/change-password').send(body);
}

function login(email: string, password: string) {
  return request(app).post('/rest/login').send({ email, password });
}

function me(cookie: string) {
  return request(app).get('/rest/login').set('Cookie', cookie);
}

/** The token from the link of the last sent mail. */
function tokenFromLastMail(): string {
  const last = mailer.sent.at(-1);
  if (!last) throw new Error('no mail sent');
  const match = /\/reset-password\?token=([\w.-]+)/.exec(last.text);
  if (!match?.[1]) throw new Error('no reset link in the mail');
  return match[1];
}

async function requestToken(email: string): Promise<string> {
  expect((await forgot(email)).status).toBe(200);
  return tokenFromLastMail();
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  mailer = createFakeMailer();
  // A fresh app per test also means fresh in-memory rate-limit counters.
  app = createApp({ config, checks: [], dataSource, mailer });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /rest/forgot-password', () => {
  it('sends one mail with a reset link to an existing user', async () => {
    await signup('jan@firma.pl');
    const res = await forgot('jan@firma.pl');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail?.to).toBe('jan@firma.pl');
    expect(mail?.text).toContain(`${config.editorBaseUrl}/reset-password?token=`);
    expect(mail?.html).toContain(`${config.editorBaseUrl}/reset-password?token=`);
  });

  it('answers 200 and sends nothing for an unknown email', async () => {
    await signup('jan@firma.pl');
    const res = await forgot('nikt@firma.pl');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(mailer.sent).toHaveLength(0);
  });

  it('Review Focus 1: email differing in case and spaces reaches the same account', async () => {
    await signup('jan@firma.pl');
    expect((await forgot(' Jan@Firma.PL ')).status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('jan@firma.pl');
  });

  it('a disabled user and an invited user (no password) get no mail, but the same 200', async () => {
    await signup('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET disabled = true`);
    await dataSource.query(
      `INSERT INTO "user" (email, first_name, last_name, role) VALUES ('inv@firma.pl', '', '', 'global:member')`,
    );
    const disabled = await forgot('jan@firma.pl');
    const invited = await forgot('inv@firma.pl');
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({});
    expect(invited.status).toBe(200);
    expect(invited.body).toEqual({});
    expect(mailer.sent).toHaveLength(0);
  });

  it('a non-email value → 400 (reveals nothing about accounts)', async () => {
    expect((await forgot('not-an-email')).status).toBe(400);
    expect((await forgot(undefined)).status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it('an SMTP failure still answers 200 and logs no token or link', async () => {
    await signup('jan@firma.pl');
    const failing: Mailer = {
      send: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1025');
      }),
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = createApp({ config, checks: [], dataSource, mailer: failing });

    const res = await forgot('jan@firma.pl', broken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    const logged = errors.mock.calls.flat().map(String).join('\n');
    expect(logged).toMatch(/password reset email/i);
    expect(logged).not.toMatch(/token|reset-password|eyJ/);
  });

  it('4th request from one IP within a minute → 429', async () => {
    for (let i = 0; i < 3; i++) expect((await forgot(`u${i}@firma.pl`)).status).toBe(200);
    const res = await forgot('u3@firma.pl');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: 'Too many requests' });
  });

  it('4th request for one email within an hour → 429, also in another spelling and after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T12:00:00Z');
    vi.setSystemTime(start);
    await signup('jan@firma.pl');
    for (let i = 0; i < 3; i++) {
      // Past the per-IP minute window each time: only the per-email limit counts here.
      vi.setSystemTime(new Date(start.getTime() + i * 61_000));
      expect((await forgot('jan@firma.pl')).status).toBe(200);
    }
    vi.setSystemTime(new Date(start.getTime() + 3 * 61_000));
    expect((await forgot(' JAN@firma.pl')).status).toBe(429);
    expect(mailer.sent).toHaveLength(3);
  });
});

describe('GET /rest/resolve-password-token', () => {
  it('200 for a valid token, 400 for garbage or a missing token', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    const ok = await resolve(token);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ mfaRequired: false });

    const bad = await resolve('garbage');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual(INVALID_TOKEN);
    const missing = await request(app).get('/rest/resolve-password-token');
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual(INVALID_TOKEN);
  });

  it('tells whether the account has 2FA on, so the page can ask for the code up front', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET mfa_enabled = true`);
    const res = await resolve(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true });
  });

  it('an email change invalidates a reset link sent to the old address', async () => {
    const { cookie } = await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    const changed = await request(app)
      .patch('/rest/me')
      .set('Cookie', cookie)
      .send({ email: 'nowy@firma.pl', currentPassword: PASSWORD });
    expect(changed.status).toBe(200);

    const res = await resolve(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_TOKEN);
    expect((await change({ token, password: NEW_PASSWORD })).status).toBe(400);
    expect((await login('nowy@firma.pl', PASSWORD)).status).toBe(200);
  });

  it('a token is valid for 20 minutes: after 21 minutes → 400', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T12:00:00Z');
    vi.setSystemTime(start);
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');

    vi.setSystemTime(new Date(start.getTime() + 19 * 60_000));
    expect((await resolve(token)).status).toBe(200);

    vi.setSystemTime(new Date(start.getTime() + 21 * 60_000));
    const res = await resolve(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_TOKEN);
    expect((await change({ token, password: NEW_PASSWORD })).status).toBe(400);
  });

  it('a session cookie value does not work as a reset token', async () => {
    const { cookie } = await signup('jan@firma.pl');
    const sessionToken = cookie.slice('moj-n8n-auth='.length);
    expect((await resolve(sessionToken)).status).toBe(400);
    const res = await change({ token: sessionToken, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_TOKEN);
    expect((await login('jan@firma.pl', PASSWORD)).status).toBe(200);
  });

  it('rejects tokens of another shape, another key or for a disabled user', async () => {
    const { id } = await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    const { ph } = jwt.decode(token) as { ph: string };
    const key = deriveKey(config.encryptionKey, 'auth-jwt');
    const sign = (payload: object, secret: Buffer | string = key) =>
      jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: 600 });

    expect((await resolve(sign({ sub: id, ph }))).status).toBe(200);
    // An invitation-shaped or session-shaped token with a matching ph is still not a reset token.
    expect((await resolve(sign({ sub: id, ph, inv: true }))).status).toBe(400);
    expect((await resolve(sign({ sub: id, ph, h: 'x', jti: 'y' }))).status).toBe(400);
    expect((await resolve(sign({ sub: id, ph: 'wrong' }))).status).toBe(400);
    expect((await resolve(sign({ sub: 'not-a-uuid', ph }))).status).toBe(400);
    expect((await resolve(sign({ sub: id, ph }, 'other-secret'))).status).toBe(400);
    const none = jwt.sign({ sub: id, ph }, '', { algorithm: 'none' });
    expect((await resolve(none)).status).toBe(400);

    await dataSource.query(`UPDATE "user" SET disabled = true`);
    expect((await resolve(token)).status).toBe(400);
  });
});

describe('POST /rest/change-password', () => {
  it('sets the new password and the same token cannot be used twice', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');

    const res = await change({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'jan@firma.pl', role: 'global:owner' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);

    expect((await login('jan@firma.pl', NEW_PASSWORD)).status).toBe(200);
    expect((await login('jan@firma.pl', PASSWORD)).status).toBe(401);

    const again = await change({ token, password: 'TrzecieHaslo789' });
    expect(again.status).toBe(400);
    expect(again.body).toEqual(INVALID_TOKEN);
    expect((await resolve(token)).status).toBe(400);
  });

  it('Review Focus 3: the cookie from before the reset → 401, the cookie from the response works', async () => {
    const { cookie: otherDevice } = await signup('jan@firma.pl');
    expect((await me(otherDevice)).status).toBe(200);
    const token = await requestToken('jan@firma.pl');

    const res = await change({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    const fresh = sessionCookie(res.headers['set-cookie']);
    expect(fresh).toBeDefined();

    expect((await me(otherDevice)).status).toBe(401);
    const current = await me(fresh as string);
    expect(current.status).toBe(200);
    expect(current.body.email).toBe('jan@firma.pl');
  });

  it('a weak new password → 400 with the policy message, the token stays valid', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    const res = await change({ token, password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: PASSWORD_POLICY_MESSAGE });
    expect((await resolve(token)).status).toBe(200);
  });

  it('garbage or missing token → 400', async () => {
    const res = await change({ token: 'garbage', password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_TOKEN);
    expect((await change({ password: NEW_PASSWORD })).status).toBe(400);
  });

  it('a user with 2FA: no code → 400 code 998; a code that cannot be verified → 400; password unchanged', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET mfa_enabled = true`);

    const missing = await change({ token, password: NEW_PASSWORD });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ code: 998, message: 'MFA required' });

    const wrong = await change({ token, password: NEW_PASSWORD, mfaCode: '123456' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ message: 'Invalid two-factor code' });
    expect(sessionCookie(wrong.headers['set-cookie'])).toBeUndefined();

    await dataSource.query(`UPDATE "user" SET mfa_enabled = false`);
    expect((await login('jan@firma.pl', PASSWORD)).status).toBe(200);
  });

  it('11th failed attempt with one token → 429 (no guessing of the 2FA code)', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    await dataSource.query(`UPDATE "user" SET mfa_enabled = true`);
    for (let i = 0; i < 10; i++) {
      const code = String(100000 + i);
      expect((await change({ token, password: NEW_PASSWORD, mfaCode: code })).status).toBe(400);
    }
    const res = await change({ token, password: NEW_PASSWORD, mfaCode: '999999' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: 'Too many requests' });
  });

  it('two simultaneous uses of one token → exactly one succeeds', async () => {
    await signup('jan@firma.pl');
    const token = await requestToken('jan@firma.pl');
    const results = await Promise.all([
      change({ token, password: NEW_PASSWORD }),
      change({ token, password: 'TrzecieHaslo789' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });
});
