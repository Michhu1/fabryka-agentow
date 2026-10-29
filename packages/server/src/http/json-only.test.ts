import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { testDeps } from '../test/app.js';
import { testConfig } from '../test/db.js';
import { jsonOnly } from './json-only.js';

const config = testConfig();
// testDeps never initializes the DataSource: these requests must be rejected before anything touches the database.
const app = createApp(testDeps(config));

describe('json-only', () => {
  it('rejects POST /rest/login with text/plain → 415', async () => {
    const res = await request(app).post('/rest/login').set('Content-Type', 'text/plain').send('email=a');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ message: 'Content-Type must be application/json' });
  });

  it('rejects a form post (classic CSRF vector) → 415', async () => {
    const res = await request(app).post('/rest/logout').type('form').send({ a: '1' });
    expect(res.status).toBe(415);
  });

  it('rejects a mutating request without any Content-Type → 415', async () => {
    const res = await request(app).delete('/rest/anything');
    expect(res.status).toBe(415);
  });

  it('lets GET without a Content-Type through', async () => {
    const res = await request(app).get('/rest/version');
    expect(res.status).toBe(200);
  });

  it('accepts application/json with a charset parameter', async () => {
    const mini = express();
    mini.use(jsonOnly);
    mini.post('/x', (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(mini)
      .post('/x')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send('{}');
    expect(res.status).toBe(200);
  });
});
