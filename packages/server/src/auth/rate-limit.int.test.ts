import { randomUUID } from 'node:crypto';
import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../app.js';
import { createRedis } from '../redis.js';
import { testConfig } from '../test/db.js';
import { createAttemptLimiter, createRateLimit } from './rate-limit.js';

const config = testConfig();
const clients: Redis[] = [];

afterAll(() => {
  for (const client of clients) client.disconnect();
});

function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.post('/x', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('rate limit with the Redis store (queue mode)', () => {
  it('works with a client that connects only after the limiter was created', async () => {
    // Same client as start.ts: lazy, connected explicitly later.
    const redis = createRedis(config.redis.url);
    clients.push(redis);
    const name = `test-${randomUUID()}`;
    const app = appWith(createRateLimit({ name, windowMs: 60_000, limit: 2, redis }));

    // Creating the limiter must not have triggered a connection attempt (start.ts connects explicitly).
    expect(redis.status).toBe('wait');
    await redis.connect();

    expect((await request(app).post('/x')).status).toBe(200);
    expect((await request(app).post('/x')).status).toBe(200);
    const blocked = await request(app).post('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ message: 'Too many requests' });

    // Counters live in Redis, so a second app instance (another worker) shares them.
    const other = appWith(createRateLimit({ name, windowMs: 60_000, limit: 2, redis }));
    expect((await request(other).post('/x')).status).toBe(429);

    const keys = await redis.keys(`rl:${name}:*`);
    expect(keys.length).toBe(1);
    await redis.del(...keys);
  });

  it('answers 503 Service unavailable while Redis is not reachable', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const redis = new Redis(config.redis.url, { lazyConnect: true, retryStrategy: () => null });
      clients.push(redis);
      const app = appWith(
        createRateLimit({ name: `test-${randomUUID()}`, windowMs: 60_000, limit: 2, redis }),
      );
      const res = await request(app).post('/x');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ message: 'Service unavailable' });
      expect(redis.status).toBe('wait');
    } finally {
      log.mockRestore();
    }
  });
});

describe('attempt limiter (per-user 2FA attempts)', () => {
  it.each([['in memory'], ['in Redis']])(
    '%s: counts attempts, refunds successes, refuses over the limit',
    async (where) => {
      let redis: Redis | undefined;
      if (where === 'in Redis') {
        redis = createRedis(config.redis.url);
        clients.push(redis);
        await redis.connect();
      }
      const name = `test-${randomUUID()}`;
      const limiter = createAttemptLimiter({ name, windowMs: 60_000, limit: 2, redis });
      expect(await limiter.take('u1')).toBe(true);
      await limiter.refund('u1'); // a success is not counted
      expect(await limiter.take('u1')).toBe(true);
      expect(await limiter.take('u1')).toBe(true);
      expect(await limiter.take('u1')).toBe(false);
      expect(await limiter.take('u2')).toBe(true); // per key
      if (redis) {
        const keys = await redis.keys(`rl:${name}:*`);
        expect(keys).toHaveLength(2);
        await redis.del(...keys);
      }
    },
  );
});
