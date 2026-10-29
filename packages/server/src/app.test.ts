import { loadConfig } from '@app/config';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { testDeps as deps } from './test/app.js';

const config = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'x'.repeat(32) });
const ok = { name: 'database', check: async () => true };
const failing = { name: 'database', check: async () => false };

describe('createApp', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await request(createApp(deps(config))).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness returns 200 when all checks pass', async () => {
    const res = await request(createApp(deps(config, [ok]))).get('/healthz/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness returns 503 and names failing check', async () => {
    const res = await request(createApp(deps(config, [failing]))).get('/healthz/readiness');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', failed: ['database'] });
  });

  it('readiness treats a throwing check as failed', async () => {
    const throwing = {
      name: 'redis',
      check: async () => {
        throw new Error('boom');
      },
    };
    const res = await request(createApp(deps(config, [throwing]))).get('/healthz/readiness');
    expect(res.status).toBe(503);
    expect(res.body.failed).toEqual(['redis']);
  });

  it('GET /metrics is disabled by default', async () => {
    const res = await request(createApp(deps(config))).get('/metrics');
    expect(res.status).toBe(404);
  });

  it('GET /metrics exposes prometheus text when enabled', async () => {
    const enabled = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'x'.repeat(32), METRICS_ENABLED: 'true' });
    const res = await request(createApp(deps(enabled))).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });

  it('GET /rest/version returns app name', async () => {
    const res = await request(createApp(deps(config))).get('/rest/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'moj-n8n', version: '0.0.0' });
  });

  it('CSP upgrades insecure requests when the editor is served over https', async () => {
    const https = loadConfig({
      NODE_ENV: 'test',
      ENCRYPTION_KEY: 'x'.repeat(32),
      EDITOR_BASE_URL: 'https://app.example.com',
    });
    const res = await request(createApp(deps(https))).get('/healthz');
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  it.each(['http://localhost:5681', 'http://192.168.1.20:5680'])(
    'CSP does not upgrade insecure requests when the editor is served over plain http (%s)',
    async (url) => {
      const http = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'x'.repeat(32), EDITOR_BASE_URL: url });
      const res = await request(createApp(deps(http))).get('/healthz');
      const csp = res.headers['content-security-policy'];
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain('upgrade-insecure-requests');
    },
  );
});
