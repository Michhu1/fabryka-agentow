import type { Request, RequestHandler } from 'express';
import {
  type ClientRateLimitInfo,
  ipKeyGenerator,
  MemoryStore,
  type Options,
  rateLimit,
  type Store,
} from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { type RedisReply, RedisStore } from 'rate-limit-redis';
import { sha256 } from '../crypto/password.js';
import { errorForLog } from '../describe-error.js';
import { HttpError } from '../http/errors.js';

/** Client IP for limiter keys; IPv6 addresses are grouped by /56 so one host cannot rotate addresses. */
export function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? '');
}

/**
 * Normalized email from the JSON body (same normalization as signup/login), hashed so Redis keys hold
 * no personal data; '' when absent.
 */
export function bodyEmailKey(req: Request): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? sha256(email.trim().toLowerCase()).slice(0, 32) : '';
}

export type RateLimitOptions = {
  /** Unique per limiter: separates the Redis keys (`rl:<name>:<key>`). */
  name: string;
  windowMs: number;
  limit: number;
  /** Defaults to the client IP. */
  key?: (req: Request) => string;
  /** Count only failed (status ≥ 400) requests, e.g. for login. */
  skipSuccessfulRequests?: boolean;
  /** Redis client in queue mode (counters shared by all instances); in-memory otherwise. */
  redis?: Redis;
};

/** A limiter answering 429 `{ message: 'Too many requests' }`. Create it at app setup, not per request. */
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const config: Partial<Options> = {
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: options.key ?? ipKey,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    handler: (_req, res) => {
      res.status(429).json({ message: 'Too many requests' });
    },
  };
  if (options.redis) config.store = lazyRedisStore(options.redis, `rl:${options.name}:`);
  return rateLimit(config);
}

/**
 * A counter of attempts per key for checks that happen inside a handler, where the key (e.g. a user id)
 * is only known after some work, so a middleware limiter cannot be used. Same stores as `createRateLimit`.
 */
export type AttemptLimiter = {
  /**
   * Counts one attempt for `key` before it is checked (counting first means parallel requests cannot all
   * slip past the limit); false when the window's limit is used up and the attempt must be refused.
   */
  take(key: string): Promise<boolean>;
  /** Gives back an attempt that succeeded, so only failures count. */
  refund(key: string): Promise<void>;
};

export function createAttemptLimiter(
  options: Omit<RateLimitOptions, 'key' | 'skipSuccessfulRequests'>,
): AttemptLimiter {
  const store: Store = options.redis
    ? lazyRedisStore(options.redis, `rl:${options.name}:`)
    : new MemoryStore();
  // Both stores read only `windowMs` from the limiter options.
  store.init?.({ windowMs: options.windowMs } as Options);
  return {
    async take(key) {
      const { totalHits } = await store.increment(key);
      return totalHits <= options.limit;
    },
    async refund(key) {
      await store.decrement(key);
    },
  };
}

/**
 * Second-factor checks (login, 2FA enable/disable, password reset and change): 5 failed codes per
 * 5 minutes per user. The login limiters are per IP, so without this someone who has the password could
 * spread guesses of the 6-digit code over many addresses.
 */
export function secondFactorAttemptLimiter(redis?: Redis): AttemptLimiter {
  return createAttemptLimiter({ name: 'second-factor-user', windowMs: 5 * 60_000, limit: 5, redis });
}

/** `POST /rest/login`: 10 failed attempts per minute per IP + email. */
export function loginRateLimit(redis?: Redis): RequestHandler {
  return createRateLimit({
    name: 'login',
    windowMs: 60_000,
    limit: 10,
    key: (req) => `${ipKey(req)}:${bodyEmailKey(req)}`,
    skipSuccessfulRequests: true,
    redis,
  });
}

/**
 * `POST /rest/login`, second limiter: 100 failed attempts per minute per IP across all emails —
 * against credential stuffing and burning server CPU on bcrypt.
 */
export function loginIpRateLimit(redis?: Redis): RequestHandler {
  return createRateLimit({
    name: 'login-ip',
    windowMs: 60_000,
    limit: 100,
    skipSuccessfulRequests: true,
    redis,
  });
}

/** `POST /rest/forgot-password`: 3 per minute per IP. */
export function forgotPasswordIpRateLimit(redis?: Redis): RequestHandler {
  return createRateLimit({ name: 'forgot-password-ip', windowMs: 60_000, limit: 3, redis });
}

/** `POST /rest/forgot-password`: 3 per hour per normalized email (no mailbox gets flooded with links). */
export function forgotPasswordEmailRateLimit(redis?: Redis): RequestHandler {
  return createRateLimit({
    name: 'forgot-password-email',
    windowMs: 60 * 60_000,
    limit: 3,
    key: bodyEmailKey,
    redis,
  });
}

/**
 * `POST /rest/change-password`: 10 failed attempts per reset token (for its 20-minute lifetime), plus
 * 20 per minute per IP. Someone holding a reset link of an account with 2FA must not be able to guess
 * the TOTP code; requesting new links is limited by `forgotPasswordEmailRateLimit`.
 */
export function changePasswordRateLimits(redis?: Redis): RequestHandler[] {
  return [
    createRateLimit({
      name: 'change-password-ip',
      windowMs: 60_000,
      limit: 20,
      skipSuccessfulRequests: true,
      redis,
    }),
    createRateLimit({
      name: 'change-password-token',
      windowMs: 20 * 60_000,
      limit: 10,
      key: (req) => {
        const token = (req.body as { token?: unknown } | undefined)?.token;
        return typeof token === 'string' ? sha256(token).slice(0, 32) : '';
      },
      skipSuccessfulRequests: true,
      redis,
    }),
  ];
}

/** `POST /rest/signup`: 5 per minute per IP. */
export function signupRateLimit(redis?: Redis): RequestHandler {
  return createRateLimit({ name: 'signup', windowMs: 60_000, limit: 5, redis });
}

/**
 * RedisStore loads its Lua scripts in `init`, which express-rate-limit calls when the limiter is
 * created — but the app is created before start.ts connects Redis (the port is bound first). So `init`
 * only records the options and the real store is initialized on first use. Commands are refused while
 * the client is not ready, instead of letting a lazyConnect client open a connection behind
 * start.ts' back (its explicit `connect()` would then fail).
 */
function lazyRedisStore(redis: Redis, prefix: string): Store {
  const inner = new RedisStore({
    prefix,
    sendCommand: async (command: string, ...args: string[]) => {
      if (redis.status !== 'ready') throw new Error('Redis is not connected');
      return (await redis.call(command, args)) as RedisReply;
    },
  });
  let options: Options | undefined;
  let ready: Promise<void> | undefined;
  const ensure = async () => {
    if (!options) throw new Error('Rate limit store used before init');
    ready ??= inner.init(options).catch((error: unknown) => {
      ready = undefined; // retry on the next request
      throw error;
    });
    await ready;
  };
  /** Redis down → 503 (the request is refused, not let through unlimited), and logged without a stack dump. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      await ensure();
      return await fn();
    } catch (error) {
      throw new HttpError(503, 'Service unavailable', undefined, undefined, error);
    }
  };
  return {
    prefix,
    init: (o: Options) => {
      options = o;
    },
    get: (key: string): Promise<ClientRateLimitInfo | undefined> => guarded(() => inner.get(key)),
    increment: (key: string) => guarded(() => inner.increment(key)),
    // Called by express-rate-limit from a response 'finish' listener nobody awaits: a throw here would be
    // an unhandled rejection, so log it instead (worst case one attempt too many is counted).
    decrement: (key: string) =>
      guarded(() => inner.decrement(key)).catch((error: unknown) => {
        console.error(errorForLog(error));
      }),
    resetKey: (key: string) => guarded(() => inner.resetKey(key)),
  };
}
