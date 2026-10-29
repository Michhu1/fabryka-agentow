import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@app/config';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { testDeps as deps } from './test/app.js';

function appWithEditor() {
  const dir = mkdtempSync(join(tmpdir(), 'editor-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  const config = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'x'.repeat(32), EDITOR_DIST_PATH: dir });
  return createApp(deps(config));
}

describe('editor static files', () => {
  it('serves editor index for unknown non-api route', async () => {
    const res = await request(appWithEditor()).get('/workflows');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('id="app"');
  });

  it('serves built assets', async () => {
    const res = await request(appWithEditor()).get('/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log(1)');
  });

  it('does not swallow api 404', async () => {
    const res = await request(appWithEditor()).get('/rest/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it.each(['/api/v1/x', '/api/v1', '/api/v2/projects', '/api'])(
    'never serves the editor for public API path %s (JSON instead)',
    async (path) => {
      const res = await request(appWithEditor()).get(path);
      expect([401, 404]).toContain(res.status);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.text).not.toContain('id="app"');
    },
  );

  it('still serves the editor for paths that only start with "api"', async () => {
    const res = await request(appWithEditor()).get('/apis');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="app"');
  });

  it.each([
    '/assets/index-abc123.js',
    '/assets/missing',
    '/assets/',
    '/old-chunk.js',
    '/styles.css',
    '/logo.png',
    '/icon.svg',
    '/font.woff2',
    '/app.js.map',
    '/projects/p1/thing.js',
  ])('answers 404 (not the editor page) for the missing asset %s', async (path) => {
    const res = await request(appWithEditor()).get(path);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('id="app"');
  });

  it('still serves the editor for app routes with a query that contains dots', async () => {
    const res = await request(appWithEditor()).get('/project-invitation?token=a.b.c');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="app"');
  });

  it('serves nothing when no editor path is configured', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'x'.repeat(32) });
    const res = await request(createApp(deps(config))).get('/workflows');
    expect(res.status).toBe(404);
  });
});
