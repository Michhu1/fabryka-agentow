import type express from 'express';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { sha256 } from '../crypto/password.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';

const config = testConfig();
let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const EMAIL = 'jan@firma.pl';
const PASSWORD = 'Haslo123';
const INVALID_CODE = { message: 'Invalid two-factor code' };
const RECOVERY_CODE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

type Setup = { secret: string; otpauthUrl: string; recoveryCodes: string[] };

/** The current TOTP code for `secret`, computed the way an authenticator app does. */
function totp(secret: string, timestamp = Date.now()): string {
  return new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate({
    timestamp,
  });
}

/** A 6-digit code that is not valid now (nor in the neighbouring 30 s windows). */
function wrongCode(secret: string): string {
  const valid = new Set([-1, 0, 1].map((step) => totp(secret, Date.now() + step * 30_000)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!valid.has(code)) return code;
  }
}

async function signup(email = EMAIL, target = app): Promise<string> {
  const res = await request(target)
    .post('/rest/signup')
    .send({ email, firstName: 'Jan', lastName: 'Kowalski', password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

function post(path: string, cookie: string | undefined, body: Record<string, unknown> = {}) {
  const req = request(app).post(path);
  return (cookie ? req.set('Cookie', cookie) : req).send(body);
}

function login(extra: Record<string, unknown> = {}, target = app, ip?: string) {
  const req = request(target).post('/rest/login');
  return (ip ? req.set('X-Forwarded-For', ip) : req).send({ email: EMAIL, password: PASSWORD, ...extra });
}

function me(cookie: string) {
  return request(app).get('/rest/login').set('Cookie', cookie);
}

async function setup(cookie: string): Promise<Setup> {
  const res = await post('/rest/mfa/setup', cookie);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.body as Setup;
}

/** Signs up, runs setup and enables 2FA; returns the session cookie and the setup data. */
async function enabledUser(): Promise<{ cookie: string } & Setup> {
  const cookie = await signup();
  const data = await setup(cookie);
  const res = await post('/rest/mfa/enable', cookie, { mfaCode: totp(data.secret) });
  expect(res.status).toBe(200);
  return { cookie, ...data };
}

function mfaColumns(): Promise<{
  mfa_enabled: boolean;
  mfa_secret: string | null;
  mfa_recovery_codes: string | null;
}> {
  return dataSource
    .query(`SELECT mfa_enabled, mfa_secret, mfa_recovery_codes FROM "user" WHERE email = $1`, [EMAIL])
    .then((rows: never[]) => rows[0] as never);
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
  // A fresh app per test also means fresh in-memory rate-limit and attempt counters.
  app = createApp({ config, checks: [], dataSource, mailer });
});

describe('POST /rest/mfa/setup', () => {
  it('returns a secret, an otpauth URL and 10 recovery codes; 2FA stays off', async () => {
    const cookie = await signup();
    const data = await setup(cookie);
    expect(data.secret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes in base32
    const url = new URL(data.otpauthUrl);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe(`/moj-n8n:${EMAIL}`);
    expect(url.searchParams.get('issuer')).toBe('moj-n8n');
    expect(url.searchParams.get('secret')).toBe(data.secret);
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
    expect(data.recoveryCodes).toHaveLength(10);
    for (const code of data.recoveryCodes) expect(code).toMatch(RECOVERY_CODE);
    expect(new Set(data.recoveryCodes).size).toBe(10);

    const profile = await me(cookie);
    expect(profile.body.mfaEnabled).toBe(false);
    // Only the setup response ever shows them.
    expect(JSON.stringify(profile.body)).not.toMatch(/secret|recovery/i);
    expect(JSON.stringify(profile.body)).not.toContain(data.secret);
    expect((await mfaColumns()).mfa_enabled).toBe(false);
    // Not enabled yet, so the login still needs no code.
    expect((await login()).status).toBe(200);
  });

  it('calling it again generates a new secret and new codes', async () => {
    const cookie = await signup();
    const first = await setup(cookie);
    const second = await setup(cookie);
    expect(second.secret).not.toBe(first.secret);
    expect(second.recoveryCodes.some((code) => first.recoveryCodes.includes(code))).toBe(false);
    // The first secret no longer enables 2FA (only a fresh code of the second does).
    const stale = await post('/rest/mfa/enable', cookie, { mfaCode: totp(first.secret) });
    if (totp(first.secret) !== totp(second.secret)) expect(stale.status).toBe(400);
  });

  it('400 when 2FA is already enabled', async () => {
    const { cookie, secret } = await enabledUser();
    const res = await post('/rest/mfa/setup', cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Two-factor authentication is already enabled' });
    // The stored secret is unchanged: the authenticator app keeps working.
    expect((await login({ mfaCode: totp(secret) })).status).toBe(200);
  });

  it('requires a session', async () => {
    expect((await post('/rest/mfa/setup', undefined)).status).toBe(401);
    expect((await post('/rest/mfa/enable', undefined, { mfaCode: '123456' })).status).toBe(401);
    expect((await post('/rest/mfa/disable', undefined, { mfaCode: '123456' })).status).toBe(401);
  });

  it('the database holds neither the secret nor any recovery code in plain text', async () => {
    const { secret, recoveryCodes } = await enabledUser();
    const row = await mfaColumns();
    expect(row.mfa_enabled).toBe(true);
    const stored = `${row.mfa_secret} ${row.mfa_recovery_codes}`;
    expect(row.mfa_secret).toMatch(/^v1:/);
    expect(row.mfa_recovery_codes).toMatch(/^v1:/);
    expect(stored).not.toContain(secret);
    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replaceAll('-', ''));
      expect(stored).not.toContain(sha256(code));
    }
  });
});

describe('POST /rest/mfa/enable', () => {
  it('setup → enable with a valid code → login needs the code', async () => {
    const cookie = await signup();
    const { secret } = await setup(cookie);
    const res = await post('/rest/mfa/enable', cookie, { mfaCode: totp(secret) });
    expect(res.status).toBe(200);
    expect(res.body.mfaEnabled).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect((await me(cookie)).body.mfaEnabled).toBe(true);

    const noCode = await login();
    expect(noCode.status).toBe(401);
    expect(noCode.body).toEqual({ code: 998, message: 'MFA required' });
    expect(sessionCookie(noCode.headers['set-cookie'])).toBeUndefined();

    const wrong = await login({ mfaCode: wrongCode(secret) });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(INVALID_CODE);
    expect(sessionCookie(wrong.headers['set-cookie'])).toBeUndefined();

    const ok = await login({ mfaCode: totp(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaEnabled).toBe(true);
    expect(sessionCookie(ok.headers['set-cookie'])).toBeDefined();
  });

  it('a code from the previous 30-second window is still accepted (window ±1)', async () => {
    const { secret } = await enabledUser();
    expect((await login({ mfaCode: totp(secret, Date.now() - 30_000) })).status).toBe(200);
    // Two windows back is too old (unless it happens to equal a current code).
    const old = totp(secret, Date.now() - 90_000);
    const current = [-1, 0, 1].map((step) => totp(secret, Date.now() + step * 30_000));
    if (!current.includes(old)) expect((await login({ mfaCode: old })).status).toBe(401);
  });

  it('a wrong code → 400 and 2FA stays off', async () => {
    const cookie = await signup();
    const { secret } = await setup(cookie);
    const res = await post('/rest/mfa/enable', cookie, { mfaCode: wrongCode(secret) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_CODE);
    expect((await mfaColumns()).mfa_enabled).toBe(false);
    expect((await login()).status).toBe(200);
  });

  it('a recovery code does not enable 2FA (it proves nothing about the authenticator app)', async () => {
    const cookie = await signup();
    const { recoveryCodes } = await setup(cookie);
    const res = await post('/rest/mfa/enable', cookie, { mfaCode: recoveryCodes[0] });
    expect(res.status).toBe(400);
    expect((await mfaColumns()).mfa_enabled).toBe(false);
  });

  it('without setup → 400', async () => {
    const cookie = await signup();
    const res = await post('/rest/mfa/enable', cookie, { mfaCode: '123456' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Set up two-factor authentication first' });
  });

  it('when already enabled → 400', async () => {
    const { cookie, secret } = await enabledUser();
    const res = await post('/rest/mfa/enable', cookie, { mfaCode: totp(secret) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Two-factor authentication is already enabled' });
  });

  it('a missing code → 400', async () => {
    const cookie = await signup();
    await setup(cookie);
    expect((await post('/rest/mfa/enable', cookie, {})).status).toBe(400);
  });
});

describe('recovery codes', () => {
  it('log in once each; the same code a second time → 401', async () => {
    const { recoveryCodes } = await enabledUser();
    const [first, second] = recoveryCodes as [string, string];

    const ok = await login({ mfaRecoveryCode: first });
    expect(ok.status).toBe(200);
    expect(sessionCookie(ok.headers['set-cookie'])).toBeDefined();

    const again = await login({ mfaRecoveryCode: first });
    expect(again.status).toBe(401);
    expect(again.body).toEqual(INVALID_CODE);

    // Typed sloppily (spaces, capitals) it is still recognised.
    expect((await login({ mfaRecoveryCode: `  ${second.toUpperCase()} ` })).status).toBe(200);
  });

  it('is recognised without dashes or with spaces instead of them', async () => {
    const { recoveryCodes } = await enabledUser();
    const [first, second] = recoveryCodes as [string, string];
    // e.g. `abcd1234efgh`
    expect((await login({ mfaRecoveryCode: first.replaceAll('-', '') })).status).toBe(200);
    expect((await login({ mfaRecoveryCode: second.replaceAll('-', ' ').toUpperCase() })).status).toBe(200);
    // Used up in its other spelling as well.
    expect((await login({ mfaRecoveryCode: first })).status).toBe(401);
  });

  it('two simultaneous logins with the same recovery code → exactly one succeeds', async () => {
    const { recoveryCodes } = await enabledUser();
    const code = recoveryCodes[0];
    const results = await Promise.all([login({ mfaRecoveryCode: code }), login({ mfaRecoveryCode: code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('an unknown recovery code → 401', async () => {
    await enabledUser();
    const res = await login({ mfaRecoveryCode: 'aaaa-bbbb-cccc' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID_CODE);
  });
});

describe('POST /rest/mfa/disable', () => {
  it('a wrong code → 400; the right one → 200, secret and codes cleared, login without a code', async () => {
    const { cookie, secret } = await enabledUser();
    const wrong = await post('/rest/mfa/disable', cookie, { mfaCode: wrongCode(secret) });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual(INVALID_CODE);
    expect((await mfaColumns()).mfa_enabled).toBe(true);

    const ok = await post('/rest/mfa/disable', cookie, { mfaCode: totp(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaEnabled).toBe(false);
    expect(await mfaColumns()).toEqual({ mfa_enabled: false, mfa_secret: null, mfa_recovery_codes: null });
    expect((await login()).status).toBe(200);
  });

  it('works with a recovery code', async () => {
    const { cookie, recoveryCodes } = await enabledUser();
    const res = await post('/rest/mfa/disable', cookie, { mfaRecoveryCode: recoveryCodes[3] });
    expect(res.status).toBe(200);
    expect((await mfaColumns()).mfa_enabled).toBe(false);
  });

  it('no code → 400 code 998', async () => {
    const { cookie } = await enabledUser();
    const res = await post('/rest/mfa/disable', cookie, {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 998, message: 'MFA required' });
  });

  it('when 2FA is not enabled → 400', async () => {
    const cookie = await signup();
    const res = await post('/rest/mfa/disable', cookie, { mfaCode: '123456' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Two-factor authentication is not enabled' });
  });

  it('after disabling, setup can start over', async () => {
    const { cookie, secret } = await enabledUser();
    expect((await post('/rest/mfa/disable', cookie, { mfaCode: totp(secret) })).status).toBe(200);
    const again = await setup(cookie);
    expect(again.secret).not.toBe(secret);
  });
});

describe('failed second-factor attempts per user', () => {
  it('the 6th failed code within 5 minutes → 429, even from other IPs and with a right code', async () => {
    const proxied = testConfig({ PROXY_HOPS: '1' });
    app = createApp({ config: proxied, checks: [], dataSource, mailer });
    const { cookie, secret } = await enabledUser();
    const bad = wrongCode(secret);

    for (let i = 0; i < 4; i++) {
      const res = await login({ mfaCode: bad }, app, `203.0.113.${i + 1}`);
      expect(res.status).toBe(401);
    }
    // Failures in other flows count for the same user.
    expect((await post('/rest/mfa/disable', cookie, { mfaCode: bad })).status).toBe(400);

    const blocked = await login({ mfaCode: totp(secret) }, app, '198.51.100.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ message: 'Too many requests' });
    expect((await post('/rest/mfa/disable', cookie, { mfaCode: totp(secret) })).status).toBe(429);
    // A wrong password is answered as before: the limit only guards the second factor.
    expect((await login({ password: 'Zlehaslo1' }, app, '198.51.100.8')).status).toBe(401);
  });

  it('successful attempts do not count', async () => {
    const { secret } = await enabledUser();
    for (let i = 0; i < 6; i++) expect((await login({ mfaCode: totp(secret) })).status).toBe(200);
  });
});

describe('password reset with 2FA', () => {
  it('change-password with a valid code → 200, the new password works', async () => {
    const { secret } = await enabledUser();
    expect((await request(app).post('/rest/forgot-password').send({ email: EMAIL })).status).toBe(200);
    const token = /\/reset-password\?token=([\w.-]+)/.exec(mailer.sent.at(-1)?.text ?? '')?.[1];
    if (!token) throw new Error('no reset link in the mail');

    const wrong = await request(app)
      .post('/rest/change-password')
      .send({ token, password: 'NoweHaslo456', mfaCode: wrongCode(secret) });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual(INVALID_CODE);

    const res = await request(app)
      .post('/rest/change-password')
      .send({ token, password: 'NoweHaslo456', mfaCode: totp(secret) });
    expect(res.status).toBe(200);
    expect(sessionCookie(res.headers['set-cookie'])).toBeDefined();
    // 2FA stays on after the reset.
    expect((await login({ password: 'NoweHaslo456' })).body).toEqual({ code: 998, message: 'MFA required' });
    expect((await login({ password: 'NoweHaslo456', mfaCode: totp(secret) })).status).toBe(200);
  });
});
