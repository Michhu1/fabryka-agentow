import { randomUUID } from 'node:crypto';
import type { ApiKeySummary, CreatedApiKey, ProjectSummary } from '@app/shared';
import type express from 'express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { sha256 } from '../crypto/password.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';

let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;

const PASSWORD = 'Haslo123';
const UNAUTHORIZED = { message: 'Unauthorized' };
const KEY_NOT_FOUND = { message: 'API key not found' };

type TestUser = { id: string; email: string; cookie: string; personalProjectId: string };
let A: TestUser;
let B: TestUser;

async function signup(email: string, firstName: string, lastName: string): Promise<TestUser> {
  const res = await request(app)
    .post('/rest/signup')
    .send({ email, firstName, lastName, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('no session cookie');
  return { id: res.body.id, email, cookie, personalProjectId: res.body.personalProjectId };
}

function createKeyRequest(user: TestUser, body: Record<string, unknown>) {
  return request(app).post('/rest/api-keys').set('Cookie', user.cookie).send(body);
}

async function createKey(user: TestUser, label = 'Integracja'): Promise<CreatedApiKey> {
  const res = await createKeyRequest(user, { label });
  expect(res.status).toBe(200);
  return res.body;
}

async function listKeys(user: TestUser): Promise<ApiKeySummary[]> {
  const res = await request(app).get('/rest/api-keys').set('Cookie', user.cookie);
  expect(res.status).toBe(200);
  return res.body;
}

function deleteKey(user: TestUser, id: string) {
  return request(app)
    .delete(`/rest/api-keys/${id}`)
    .set('Cookie', user.cookie)
    .set('Content-Type', 'application/json');
}

function publicGet(path: string, key?: string) {
  const req = request(app).get(`/api/v1${path}`);
  return key === undefined ? req : req.set('X-API-KEY', key);
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

beforeEach(async () => {
  await truncateAll(dataSource);
  // A fresh app per test: fresh in-memory rate-limit counters.
  mailer = createFakeMailer();
  app = createApp({ config: testConfig(), checks: [], dataSource, mailer });
  A = await signup('anna@firma.pl', 'Anna', 'Adamska');
  B = await signup('bartek@firma.pl', 'Bartek', 'Bielski');
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe('session required for /rest/api-keys', () => {
  it.each([
    ['get', '/rest/api-keys'],
    ['post', '/rest/api-keys'],
    ['delete', `/rest/api-keys/${randomUUID()}`],
  ] as const)('%s %s → 401', async (method, path) => {
    const res = await request(app)[method](path).set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });
});

describe('creating and listing keys', () => {
  it('returns the raw key once (mn8_…); the list never contains it', async () => {
    const res = await createKeyRequest(A, { label: '  Integracja  ' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const created: CreatedApiKey = res.body;
    expect(created.rawKey).toMatch(/^mn8_[A-Za-z0-9_-]{43}$/);
    expect(created).toEqual({
      id: expect.any(String),
      label: 'Integracja',
      hint: created.rawKey.slice(-4),
      createdAt: expect.any(String),
      expiresAt: null,
      lastUsedAt: null,
      rawKey: created.rawKey,
    });
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);

    const listRes = await request(app).get('/rest/api-keys').set('Cookie', A.cookie);
    expect(listRes.status).toBe(200);
    expect(listRes.text).not.toContain(created.rawKey);
    const { rawKey: _raw, ...summary } = created;
    expect(listRes.body).toEqual([summary]);
    expect(await listKeys(B)).toEqual([]);
  });

  it('stores only the sha256 hash of the key, never the key itself', async () => {
    const created = await createKey(A);
    const rows: Record<string, unknown>[] = await dataSource.query(`SELECT * FROM api_key`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key_hash).toBe(sha256(created.rawKey));
    expect(rows[0]?.hint).toBe(created.rawKey.slice(-4));
    expect(JSON.stringify(rows)).not.toContain(created.rawKey);
    expect(JSON.stringify(rows)).not.toContain(created.rawKey.slice(4));
  });

  it('lists own keys, newest first', async () => {
    const first = await createKey(A, 'Pierwszy');
    const second = await createKey(A, 'Drugi');
    await createKey(B, 'Bartka');
    const keys = await listKeys(A);
    expect(keys.map((k) => k.id)).toEqual([second.id, first.id]);
  });

  it('accepts a future expiresAt and returns it as ISO', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const res = await createKeyRequest(A, { label: 'Tymczasowy', expiresAt });
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe(expiresAt);
    expect((await listKeys(A))[0]?.expiresAt).toBe(expiresAt);
  });

  it('accepts expiresAt null (never expires)', async () => {
    const res = await createKeyRequest(A, { label: 'Stały', expiresAt: null });
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeNull();
  });

  it.each([
    [{}, 'Label is required'],
    [{ label: '   ' }, 'Label is required'],
    [{ label: 'x'.repeat(101) }, 'Label must be at most 100 characters'],
    [{ label: 5 }, 'Label is required'],
    [{ label: 'Klucz', expiresAt: 'jutro' }, 'expiresAt must be an ISO date-time'],
    [{ label: 'Klucz', expiresAt: '2020-01-01T00:00:00Z' }, 'expiresAt must be in the future'],
    [{ label: 'Klucz', role: 'global:owner' }, 'Unknown field: role'],
  ])('invalid body %j → 400 %s', async (body, message) => {
    const res = await createKeyRequest(A, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message });
    expect(await listKeys(A)).toEqual([]);
  });

  it('allows at most 10 keys per user', async () => {
    for (let i = 0; i < 10; i++) await createKey(A, `Klucz ${i}`);
    const res = await createKeyRequest(A, { label: 'Jedenasty' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'API key limit reached (10)' });
    // The limit is per user: B is not affected.
    await createKey(B);
  });

  it('enforces the limit under concurrent creates', async () => {
    for (let i = 0; i < 8; i++) await createKey(A, `Klucz ${i}`);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createKeyRequest(A, { label: `Równoległy ${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(await listKeys(A)).toHaveLength(10);
  });

  it('requires a JSON content type for creating', async () => {
    const res = await request(app)
      .post('/rest/api-keys')
      .set('Cookie', A.cookie)
      .set('Content-Type', 'text/plain')
      .send('label=x');
    expect(res.status).toBe(415);
  });
});

describe('deleting keys', () => {
  it('deletes an own key; it stops working at once', async () => {
    const key = await createKey(A);
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
    const res = await deleteKey(A, key.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(await listKeys(A)).toEqual([]);
    const after = await publicGet('/projects', key.rawKey);
    expect(after.status).toBe(401);
    expect(after.body).toEqual(UNAUTHORIZED);
  });

  it("B deleting A's key → 404, and A's key keeps working", async () => {
    const key = await createKey(A);
    const res = await deleteKey(B, key.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(KEY_NOT_FOUND);
    expect(await listKeys(A)).toHaveLength(1);
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
  });

  it.each([randomUUID(), 'nie-uuid'])('unknown id %s → 404', async (id) => {
    const res = await deleteKey(A, id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(KEY_NOT_FOUND);
  });
});

describe('public API /api/v1', () => {
  it("GET /api/v1/projects with a key → the key owner's projects", async () => {
    const team = await request(app).post('/rest/projects').set('Cookie', A.cookie).send({ name: 'Zespół' });
    expect(team.status).toBe(200);
    const key = await createKey(A);
    const res = await publicGet('/projects', key.rawKey);
    expect(res.status).toBe(200);
    const mine = await request(app).get('/rest/projects/my-projects').set('Cookie', A.cookie);
    expect(res.body).toEqual({ data: mine.body });
    const ids = (res.body.data as ProjectSummary[]).map((p) => p.id);
    expect(ids).toEqual([A.personalProjectId, team.body.id]);
    expect(ids).not.toContain(B.personalProjectId);
  });

  it('without a key → 401 JSON', async () => {
    const res = await publicGet('/projects');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it.each(['mn8_nieprawidlowy', 'zupelnie-inny', '', `mn8_${'a'.repeat(500)}`])(
    'with an invalid key %j → 401',
    async (key) => {
      const res = await publicGet('/projects', key);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
    },
  );

  it('does not accept the session cookie (401), only X-API-KEY', async () => {
    const res = await request(app).get('/api/v1/projects').set('Cookie', A.cookie);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it('does not accept the key in other places (Authorization header, query string)', async () => {
    const key = await createKey(A);
    const bearer = await request(app).get('/api/v1/projects').set('Authorization', `Bearer ${key.rawKey}`);
    expect(bearer.status).toBe(401);
    const query = await request(app).get(`/api/v1/projects?api_key=${key.rawKey}`);
    expect(query.status).toBe(401);
  });

  it('an expired key → 401', async () => {
    const key = await createKey(A);
    await dataSource.query(`UPDATE api_key SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      key.id,
    ]);
    const res = await publicGet('/projects', key.rawKey);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it('a key with expiresAt still in the future works', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const created = await createKeyRequest(A, { label: 'Godzina', expiresAt });
    expect((await publicGet('/projects', created.body.rawKey)).status).toBe(200);
  });

  it("a disabled owner's key → 401", async () => {
    const key = await createKey(B);
    await dataSource.query(`UPDATE "user" SET disabled = true WHERE id = $1`, [B.id]);
    const res = await publicGet('/projects', key.rawKey);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it('a key of an owner without a password → 401', async () => {
    const key = await createKey(B);
    await dataSource.query(`UPDATE "user" SET password_hash = NULL WHERE id = $1`, [B.id]);
    expect((await publicGet('/projects', key.rawKey)).status).toBe(401);
  });

  it("a deleted owner's key → 401", async () => {
    const key = await createKey(B);
    await dataSource.query(`DELETE FROM "user" WHERE id = $1`, [B.id]);
    expect((await publicGet('/projects', key.rawKey)).status).toBe(401);
  });

  // Owner decision 7 (after PR #1): like n8n, a password change does not revoke API keys.
  it('a key keeps working after the owner changes the password', async () => {
    const key = await createKey(A);
    const changed = await request(app)
      .patch('/rest/me/password')
      .set('Cookie', A.cookie)
      .send({ currentPassword: PASSWORD, newPassword: 'NoweHaslo456' });
    expect(changed.status).toBe(200);
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
  });

  it('a key keeps working after the owner resets the password', async () => {
    const key = await createKey(A);
    expect((await request(app).post('/rest/forgot-password').send({ email: A.email })).status).toBe(200);
    // The reset mail is sent without awaiting it; wait until the fake mailer has it.
    await expect.poll(() => mailer.sent.length).toBe(1);
    const token = /token=([A-Za-z0-9_.-]+)/.exec(mailer.sent[0]?.text ?? '')?.[1];
    expect(token).toBeDefined();
    const reset = await request(app).post('/rest/change-password').send({ token, password: 'NoweHaslo456' });
    expect(reset.status).toBe(200);
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
  });

  it('sets last_used_at on use, at most once a minute', async () => {
    const key = await createKey(A);
    expect((await listKeys(A))[0]?.lastUsedAt).toBeNull();
    const before = Date.now();
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
    const first = (await listKeys(A))[0]?.lastUsedAt;
    expect(first).not.toBeNull();
    expect(new Date(first as string).getTime()).toBeGreaterThanOrEqual(before - 5_000);

    // A second request within the minute does not write again.
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
    expect((await listKeys(A))[0]?.lastUsedAt).toBe(first);

    // Once the stored time is older than a minute, the next request refreshes it.
    await dataSource.query(`UPDATE api_key SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [
      key.id,
    ]);
    const stale = (await listKeys(A))[0]?.lastUsedAt as string;
    expect((await publicGet('/projects', key.rawKey)).status).toBe(200);
    const refreshed = (await listKeys(A))[0]?.lastUsedAt as string;
    expect(new Date(refreshed).getTime()).toBeGreaterThan(new Date(stale).getTime());
  });

  it('limits each key to 60 requests per minute (429 JSON); other keys are not affected', async () => {
    const key = await createKey(A);
    const other = await createKey(B);
    for (let i = 0; i < 60; i++) {
      const res = await publicGet('/projects', key.rawKey);
      expect(res.status).toBe(200);
    }
    const limited = await publicGet('/projects', key.rawKey);
    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toContain('application/json');
    expect(limited.body).toEqual({ message: 'Too many requests' });
    expect((await publicGet('/projects', other.rawKey)).status).toBe(200);
  });

  it('GET /api/v1/nieistnieje with a key → JSON 404, not the editor HTML', async () => {
    const key = await createKey(A);
    const res = await publicGet('/nieistnieje', key.rawKey);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ message: 'Not found' });
  });

  it('GET /api/v1/nieistnieje without a key → JSON 401, never HTML', async () => {
    const res = await publicGet('/nieistnieje');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual(UNAUTHORIZED);
  });
});
