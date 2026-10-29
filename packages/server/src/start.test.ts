import net from 'node:net';
import { loadConfig } from '@app/config';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { listen, StartupError, start } from './start.js';
import { testDeps as deps } from './test/app.js';

describe('listen', () => {
  it('reports a busy port with a readable error', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const config = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'x'.repeat(32), PORT: String(port) });
    try {
      await expect(listen(createApp(deps(config)), port)).rejects.toThrow(
        new StartupError(`Port ${port} is already in use`),
      );
    } finally {
      blocker.close();
    }
  });
});

describe('start', () => {
  it('reports a busy port before touching the database', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    // Unreachable DB: if start() tried the DB first, this would take seconds and fail differently.
    const config = loadConfig({
      NODE_ENV: 'test',
      ENCRYPTION_KEY: 'x'.repeat(32),
      PORT: String(port),
      DB_POSTGRESDB_PORT: '1',
    });
    const startedAt = Date.now();
    try {
      await expect(start(config)).rejects.toThrow(new StartupError(`Port ${port} is already in use`));
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      blocker.close();
    }
  });
});
