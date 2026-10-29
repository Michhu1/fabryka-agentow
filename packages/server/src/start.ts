import type { Server } from 'node:http';
import type { AppConfig } from '@app/config';
import type express from 'express';
import type { DataSource } from 'typeorm';
import { createApp, type ReadinessCheck } from './app.js';
import { connectWithRetry } from './connect-with-retry.js';
import { createDataSource } from './db/data-source.js';
import { describeError } from './describe-error.js';
import { createSmtpMailer } from './mail/mailer.js';
import { createRedis, enableReconnect } from './redis.js';

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

export function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => resolve(server));
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE' ? new StartupError(`Port ${port} is already in use`) : error);
    });
  });
}

export type RunningServer = { dataSource: DataSource; close(): Promise<void> };

const RETRY = { attempts: 5, baseDelayMs: 500 };

/**
 * Binds the port first (a clash is reported instantly), then connects the database, runs
 * migrations and — in queue mode — connects Redis. Readiness stays 503 until all are up.
 * Any failure cleans up what was opened and surfaces as a one-line StartupError.
 */
export async function start(config: AppConfig): Promise<RunningServer> {
  const dataSource = createDataSource(config);
  // Created now (not connected yet) so the app's rate limiters can hold it; connected below.
  const redis = config.executionsMode === 'queue' ? createRedis(config.redis.url) : undefined;
  let dbReady = false;

  const checks: ReadinessCheck[] = [
    {
      name: 'database',
      check: async () => {
        if (!dbReady) return false;
        await dataSource.query('SELECT 1');
        return true;
      },
    },
  ];

  const app = createApp({ config, checks, dataSource, mailer: createSmtpMailer(config.smtp), redis });
  const server = await listen(app, config.port);

  const cleanup = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    redis?.disconnect();
    if (dataSource.isInitialized) await dataSource.destroy();
  };

  const step = async (failure: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      await cleanup().catch(() => {});
      throw new StartupError(`${failure} (${describeError(error)})`);
    }
  };

  await step(`Cannot connect to PostgreSQL at ${config.db.host}:${config.db.port}`, () =>
    connectWithRetry(() => dataSource.initialize(), RETRY),
  );
  await step('Database migration failed', () => dataSource.runMigrations());
  dbReady = true;

  if (redis) {
    const client = redis;
    await step(`Cannot connect to Redis at ${config.redis.url}`, () =>
      connectWithRetry(() => client.connect(), RETRY),
    );
    enableReconnect(client);
    checks.push({ name: 'redis', check: async () => (await client.ping()) === 'PONG' });
  }

  return { dataSource, close: cleanup };
}
