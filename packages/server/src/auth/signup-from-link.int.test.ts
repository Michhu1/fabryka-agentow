import type express from 'express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createFakeMailer, sessionCookie } from '../test/app.js';
import { createTestDataSource, testConfig, truncateAll } from '../test/db.js';
import { mailedToken } from '../test/projects.js';

/**
 * With `SIGNUP_ENABLED=false` a person who was sent a project invitation or a project transfer may
 * still create an account — for the address the link was sent to, while the link is valid. Instance
 * invitations have their own accept route, which never depended on the signup switch.
 */
const PASSWORD = 'Haslo123';
const DAY = 24 * 60 * 60_000;
const DISABLED = { message: 'Signup is disabled' };

let dataSource: DataSource;
let app: express.Express;
let mailer: ReturnType<typeof createFakeMailer>;
let ownerCookie: string;
let projectId: string;

function signup(email: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/rest/signup')
    .send({ email, firstName: 'Nowy', lastName: 'Gość', password: PASSWORD, ...extra });
}

function asOwner(path: string, body: Record<string, unknown>) {
  return request(app).post(`/rest${path}`).set('Cookie', ownerCookie).send(body);
}

async function invitationToken(email: string): Promise<string> {
  const res = await asOwner(`/projects/${projectId}/invitations`, { email, role: 'project:editor' });
  expect(res.status).toBe(200);
  return mailedToken(mailer, email, 'project-invitation');
}

async function transferToken(email: string): Promise<string> {
  const res = await asOwner(`/projects/${projectId}/transfer`, { email, currentPassword: PASSWORD });
  expect(res.status).toBe(200);
  return mailedToken(mailer, email, 'project-transfer');
}

beforeAll(async () => {
  dataSource = await createTestDataSource();
});

afterAll(async () => {
  await dataSource.destroy();
});

/** A new app (fresh in-memory rate-limit counters) on the same database and mailer. */
function freshApp(env: Record<string, string> = { SIGNUP_ENABLED: 'false' }) {
  app = createApp({ config: testConfig(env), checks: [], dataSource, mailer });
}

beforeEach(async () => {
  await truncateAll(dataSource);
  mailer = createFakeMailer();
  freshApp();
  // The first account may always sign up (it becomes the instance owner).
  const owner = await signup('olga@firma.pl', { firstName: 'Olga', lastName: 'Owczarek' });
  expect(owner.status).toBe(200);
  ownerCookie = sessionCookie(owner.headers['set-cookie']) ?? '';
  const project = await asOwner('/projects', { name: 'Biuro' });
  expect(project.status).toBe(200);
  projectId = project.body.id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signup with SIGNUP_ENABLED=false', () => {
  it('without a link → 403', async () => {
    const res = await signup('nowy@firma.pl');
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DISABLED);
  });

  it('a project invitation link lets its address sign up (any case) and then accept', async () => {
    const token = await invitationToken('nowy@firma.pl');
    const res = await signup(' Nowy@Firma.PL ', { inviteToken: token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'nowy@firma.pl', role: 'global:member' });
    const cookie = sessionCookie(res.headers['set-cookie']) ?? '';

    // Signing up does not use the invitation up: joining still needs "Akceptuj".
    const accepted = await request(app)
      .post('/rest/project-invitations/accept')
      .set('Cookie', cookie)
      .send({ token });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: projectId, role: 'project:editor' });
  });

  it('a project transfer link lets its address sign up and then accept', async () => {
    const token = await transferToken('nowa@firma.pl');
    const res = await signup('nowa@firma.pl', { inviteToken: token });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res.headers['set-cookie']) ?? '';
    const accepted = await request(app)
      .post('/rest/project-transfers/accept')
      .set('Cookie', cookie)
      .send({ token });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: projectId, role: 'project:admin' });
  });

  it('a link for another address, an unknown or malformed token → the same 403', async () => {
    const invitation = await invitationToken('nowy@firma.pl');
    const transfer = await transferToken('nowa@firma.pl');
    for (const [email, inviteToken] of [
      ['inny@firma.pl', invitation],
      ['inny@firma.pl', transfer],
      ['nowy@firma.pl', transfer],
      ['nowy@firma.pl', 'A'.repeat(43)],
      ['nowy@firma.pl', 'not a token'],
      ['nowy@firma.pl', ''],
    ] as const) {
      freshApp(); // the signup limit is 5 a minute per IP
      const res = await signup(email, { inviteToken });
      expect(res.status, `${email} ${inviteToken}`).toBe(403);
      expect(res.body).toEqual(DISABLED);
    }
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM "user"`);
    expect(n).toBe(1);
  });

  it('an expired or cancelled link → 403', async () => {
    const token = await invitationToken('nowy@firma.pl');
    const transfer = await transferToken('nowa@firma.pl');
    const cancelled = await request(app)
      .delete(`/rest/projects/${projectId}/transfer`)
      .set('Cookie', ownerCookie)
      .set('Content-Type', 'application/json');
    expect(cancelled.status).toBe(200);
    expect((await signup('nowa@firma.pl', { inviteToken: transfer })).status).toBe(403);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 7 * DAY + 60_000);
    const res = await signup('nowy@firma.pl', { inviteToken: token });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DISABLED);
  });

  it('a link of a blocked project (owner disabled) → 403', async () => {
    const token = await invitationToken('nowy@firma.pl');
    await dataSource.query(`UPDATE "user" SET disabled = true WHERE email = 'olga@firma.pl'`);
    expect((await signup('nowy@firma.pl', { inviteToken: token })).status).toBe(403);
  });

  it('a transfer link whose sender is no longer the project owner → 403 (as on the link page)', async () => {
    const token = await transferToken('nowa@firma.pl');
    await dataSource.query(
      `UPDATE project_relation SET role = 'project:editor' WHERE project_id = $1 AND role = 'project:admin'`,
      [projectId],
    );
    expect((await request(app).get('/rest/project-transfers/resolve').query({ token })).status).toBe(400);
    const res = await signup('nowa@firma.pl', { inviteToken: token });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DISABLED);
  });

  it('inviteToken must be a string (strict body)', async () => {
    const res = await signup('nowy@firma.pl', { inviteToken: 42 });
    expect(res.status).toBe(400);
  });

  it('an instance invitation is accepted on its own route', async () => {
    const invited = await asOwner('/invitations', { emails: ['jan@firma.pl'], role: 'global:member' });
    expect(invited.status).toBe(200);
    const mail = mailer.sent.find((m) => m.to === 'jan@firma.pl');
    const token = /\/accept-invite\?token=([\w.-]+)/.exec(mail?.text ?? '')?.[1];
    const res = await request(app)
      .post('/rest/invitations/accept')
      .send({ token, firstName: 'Jan', lastName: 'Kowalski', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'jan@firma.pl', role: 'global:member' });
  });
});

describe('signup with SIGNUP_ENABLED=true', () => {
  it('an inviteToken that is not valid does not matter', async () => {
    freshApp({});
    const res = await signup('nowy@firma.pl', { inviteToken: 'A'.repeat(43) });
    expect(res.status).toBe(200);
  });
});
