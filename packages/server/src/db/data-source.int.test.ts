import { afterAll, describe, expect, it } from 'vitest';
import { start } from '../start.js';
import { testConfig } from '../test/db.js';

const config = testConfig({ PORT: '5699' });
let server: Awaited<ReturnType<typeof start>> | undefined;

describe('database (requires pnpm infra:up)', () => {
  afterAll(async () => server?.close());

  it('migrations create settings table and readiness is ok', async () => {
    server = await start(config);
    const rows = await server.dataSource.query(`select to_regclass('settings') as t`);
    expect(rows[0].t).toBe('settings');
    const res = await fetch('http://localhost:5699/healthz/readiness');
    expect(res.status).toBe(200);
  });
});
