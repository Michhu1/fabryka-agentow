import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { testDeps } from '../test/app.js';
import { testConfig } from '../test/db.js';

// Invalid bodies are rejected by validation (400) before any database access, and still count as
// failed attempts, so these limiter tests need no database.

function signupFrom(app: ReturnType<typeof createApp>, ip: string) {
  return request(app).post('/rest/signup').set('X-Forwarded-For', ip).send({});
}

describe('client IP behind proxies (PROXY_HOPS)', () => {
  it('with PROXY_HOPS=1 the limiter keys on X-Forwarded-For', async () => {
    const app = createApp(testDeps(testConfig({ PROXY_HOPS: '1' })));
    for (let i = 0; i < 5; i++) expect((await signupFrom(app, '203.0.113.1')).status).toBe(400);
    expect((await signupFrom(app, '203.0.113.1')).status).toBe(429);
    expect((await signupFrom(app, '203.0.113.2')).status).toBe(400);
  });

  it('with PROXY_HOPS=0 (default) X-Forwarded-For is ignored, so it cannot be spoofed', async () => {
    const app = createApp(testDeps(testConfig()));
    for (let i = 0; i < 5; i++) expect((await signupFrom(app, `203.0.113.${i}`)).status).toBe(400);
    expect((await signupFrom(app, '203.0.113.99')).status).toBe(429);
  });
});

describe('login limit per IP across emails', () => {
  it('101st failed login from one IP within a minute → 429, whatever the email', async () => {
    const app = createApp(testDeps(testConfig()));
    // Missing password → 400 before the database; each email stays far below its own limit of 10.
    for (let i = 0; i < 100; i++) {
      const res = await request(app)
        .post('/rest/login')
        .send({ email: `u${i}@firma.pl` });
      expect(res.status).toBe(400);
    }
    const res = await request(app).post('/rest/login').send({ email: 'new@firma.pl' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: 'Too many requests' });
  });
});
