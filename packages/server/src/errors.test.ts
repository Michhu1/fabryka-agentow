import { loadConfig } from '@app/config';
import express from 'express';
import request from 'supertest';
import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp, errorHandler } from './app.js';
import { HttpError, validate } from './http/errors.js';
import { testDeps } from './test/app.js';

const config = loadConfig({ NODE_ENV: 'development', ENCRYPTION_KEY: 'x'.repeat(32) });

/** A tiny app whose only route throws `error`, behind the real error handler. */
function throwing(error: unknown) {
  const app = express();
  app.get('/x', () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe('error handling', () => {
  it('answers malformed JSON with a JSON 400 and no stack trace', async () => {
    const res = await request(createApp(testDeps(config)))
      .post('/rest/version')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ message: 'Invalid JSON body' });
    expect(res.text).not.toContain('at ');
  });

  it('shows a 4xx HttpError message, with code only when set', async () => {
    const plain = await request(throwing(new HttpError(404, 'Project not found'))).get('/x');
    expect(plain.status).toBe(404);
    expect(plain.body).toEqual({ message: 'Project not found' });

    const coded = await request(throwing(new HttpError(401, 'MFA required', 998))).get('/x');
    expect(coded.status).toBe(401);
    expect(coded.body).toEqual({ message: 'MFA required', code: 998 });
  });

  it('merges extra fields, which cannot override message or code', async () => {
    const error = new HttpError(409, 'Busy', 7, {
      projects: [{ id: '1', name: 'A' }],
      message: 'x',
      code: 1,
    });
    const res = await request(throwing(error)).get('/x');
    expect(res.body).toEqual({ message: 'Busy', code: 7, projects: [{ id: '1', name: 'A' }] });
  });

  it('hides the message of a 5xx HttpError and of unknown errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const http500 = await request(throwing(new HttpError(500, 'db password is hunter2'))).get('/x');
      expect(http500.status).toBe(500);
      expect(http500.body).toEqual({ message: 'Internal server error' });
      const unknown = await request(throwing(new Error('secret detail'))).get('/x');
      expect(unknown.body).toEqual({ message: 'Internal server error' });
    } finally {
      log.mockRestore();
    }
  });
});

describe('error logging', () => {
  it('logs a failed query without its parameters or the driver detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const driverError = Object.assign(
        new Error('duplicate key value violates unique constraint "UQ_user_email"'),
        {
          code: '23505',
          detail: 'Key (email)=(jan@firma.pl) already exists.',
        },
      );
      const error = new QueryFailedError(
        'INSERT INTO "user"("email", "password_hash") VALUES ($1, $2)',
        ['jan@firma.pl', '$2b$10$secretsecretsecretsecretsecret'],
        driverError,
      );
      const res = await request(throwing(error)).get('/x');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: 'Internal server error' });
      const out = JSON.stringify(log.mock.calls);
      expect(out).toContain('UQ_user_email');
      expect(out).not.toContain('$2b$10$secret');
      expect(out).not.toContain('jan@firma.pl');
    } finally {
      log.mockRestore();
    }
  });

  it('answers 503 Service unavailable for an error with status 503', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(throwing(new HttpError(503, 'Redis is not connected'))).get('/x');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ message: 'Service unavailable' });
    } finally {
      log.mockRestore();
    }
  });
});

describe('validate', () => {
  const schema = z.object({
    name: z.string({ error: 'Name is required' }).min(1, { error: 'Name is empty' }),
  });

  it('returns parsed data', () => {
    expect(validate(schema, { name: 'a', extra: 1 })).toEqual({ name: 'a' });
  });

  it('throws 400 with the first issue message', () => {
    expect(() => validate(schema, {})).toThrow(new HttpError(400, 'Name is required'));
    try {
      validate(schema, { name: '' });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).message).toBe('Name is empty');
    }
  });
});
