import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedis, enableReconnect } from './redis.js';
import { testConfig } from './test/db.js';

const config = testConfig();
const clients: Redis[] = [];

afterAll(() => {
  for (const client of clients) client.disconnect();
});

async function waitFor(condition: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('redis client (queue mode)', () => {
  it('does not retry on its own before the first connect', () => {
    const client = createRedis(config.redis.url);
    clients.push(client);
    expect(client.status).toBe('wait');
    expect(client.options.retryStrategy?.(1)).toBeNull();
  });

  it('reconnects with a bounded backoff after the connection is dropped', async () => {
    const client = createRedis(config.redis.url);
    const admin = new Redis(config.redis.url);
    clients.push(client, admin);
    await client.connect();
    enableReconnect(client);
    expect(client.options.retryStrategy?.(100)).toBe(2000);

    const id = await client.client('ID');
    await admin.client('KILL', 'ID', String(id));
    await waitFor(() => client.status !== 'ready');
    await waitFor(() => client.status === 'ready');
    expect(await client.ping()).toBe('PONG');
  });
});
