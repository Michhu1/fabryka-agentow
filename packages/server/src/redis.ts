import { Redis } from 'ioredis';

/**
 * A Redis client that is not connected yet (lazyConnect) and does not retry on its own: start.ts
 * connects it with `connectWithRetry`, so each startup attempt is one clean connection.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
}

/** After the first successful connect: reconnect on dropped connections with a backoff capped at 2 s. */
export function enableReconnect(client: Redis): void {
  client.options.retryStrategy = (attempt: number) => Math.min(attempt * 200, 2000);
}
