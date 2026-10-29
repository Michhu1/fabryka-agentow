import { API_KEYS_LIMIT, type ApiKeySummary, type CreatedApiKey } from '@app/shared';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { UUID } from '../auth/session.js';
import { randomToken, sha256 } from '../crypto/password.js';
import { ApiKey } from '../db/entities/api-key.entity.js';
import type { User } from '../db/entities/user.entity.js';
import { describeError } from '../describe-error.js';
import { HttpError, strictBody, validate } from '../http/errors.js';

/** Recognizable prefix (secret scanners, support) + 32 random bytes in base64url (43 characters). */
const KEY_PREFIX = 'mn8_';
const KEY_SHAPE = /^mn8_[A-Za-z0-9_-]{43}$/;
/** `last_used_at` is written at most this often per key, so a busy key does not write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

const KEY_NOT_FOUND = 'API key not found';

const createSchema = strictBody({
  label: z
    .string({ error: 'Label is required' })
    .trim()
    .min(1, { error: 'Label is required' })
    .max(100, { error: 'Label must be at most 100 characters' }),
  /** ISO date-time with `Z` or an offset; `null` or absent = never expires. */
  expiresAt: z.iso
    .datetime({ offset: true, error: 'expiresAt must be an ISO date-time' })
    .refine((value) => Date.parse(value) > Date.now(), { error: 'expiresAt must be in the future' })
    .nullable()
    .optional(),
});

export type ApiKeyService = {
  /** The user's keys, newest first, without the keys themselves. */
  list(userId: string): Promise<ApiKeySummary[]>;
  /** Creates a key; the response is the only place the full key ever appears. */
  create(userId: string, input: unknown): Promise<CreatedApiKey>;
  /** Deletes one of the user's own keys; anyone else's (or a nonexistent one) is 404. */
  remove(userId: string, keyId: string): Promise<void>;
  /**
   * The owner of a raw key from the `X-API-KEY` header, or null when the key is malformed, unknown,
   * deleted or expired, or its owner is disabled or has no password (invited, not activated).
   */
  authenticate(rawKey: string | undefined): Promise<{ user: User; keyId: string } | null>;
};

function toSummary(key: ApiKey): ApiKeySummary {
  return {
    id: key.id,
    label: key.label,
    hint: key.hint,
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * Personal keys for the public API (n8n: Settings → n8n API). Only `sha256(key)` is stored: the key has
 * 256 bits of entropy, so a fast hash is enough (no bcrypt needed) and the lookup is a single indexed
 * query. A database leak therefore reveals no usable key.
 */
export function createApiKeyService(deps: { dataSource: DataSource }): ApiKeyService {
  const { dataSource } = deps;

  /**
   * Not on every request (see `LAST_USED_RESOLUTION_MS`); awaited so the value is current when the
   * response arrives, but a failed write never fails the request — it is logged without parameters.
   */
  async function recordUse(key: ApiKey): Promise<void> {
    if (key.lastUsedAt && Date.now() - key.lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return;
    try {
      await dataSource.query(
        `UPDATE api_key SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [key.id],
      );
    } catch (error) {
      console.error(`Last use of API key ${key.id} could not be recorded (${describeError(error)})`);
    }
  }

  return {
    async list(userId) {
      const keys = await dataSource
        .getRepository(ApiKey)
        .find({ where: { userId }, order: { createdAt: 'DESC', id: 'DESC' } });
      return keys.map(toSummary);
    },

    async create(userId, raw) {
      const input = validate(createSchema, raw);
      const rawKey = `${KEY_PREFIX}${randomToken(32)}`;
      const key = await dataSource.transaction(async (em) => {
        // Locking the owner's row serializes their concurrent creates, so parallel requests cannot all
        // pass the count below. NO KEY UPDATE does not block foreign key checks on the user.
        const locked: unknown[] = await em.query(`SELECT id FROM "user" WHERE id = $1 FOR NO KEY UPDATE`, [
          userId,
        ]);
        if (locked.length === 0) throw new HttpError(401, 'Unauthorized');
        const counted: { count: number }[] = await em.query(
          `SELECT count(*)::int AS count FROM api_key WHERE user_id = $1`,
          [userId],
        );
        if ((counted[0]?.count ?? 0) >= API_KEYS_LIMIT) {
          throw new HttpError(400, `API key limit reached (${API_KEYS_LIMIT})`);
        }
        return em.save(
          em.create(ApiKey, {
            userId,
            label: input.label,
            keyHash: sha256(rawKey),
            hint: rawKey.slice(-4),
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            lastUsedAt: null,
          }),
        );
      });
      return { ...toSummary(key), rawKey };
    },

    async remove(userId, keyId) {
      if (!UUID.test(keyId)) throw new HttpError(404, KEY_NOT_FOUND);
      const result = await dataSource.getRepository(ApiKey).delete({ id: keyId, userId });
      if (!result.affected) throw new HttpError(404, KEY_NOT_FOUND);
    },

    async authenticate(rawKey) {
      // Anything that cannot be one of our keys is refused without hashing or a query.
      if (typeof rawKey !== 'string' || !KEY_SHAPE.test(rawKey)) return null;
      const key = await dataSource
        .getRepository(ApiKey)
        .createQueryBuilder('k')
        .innerJoinAndSelect('k.user', 'u')
        .where('k.key_hash = :keyHash', { keyHash: sha256(rawKey) })
        // The database clock decides expiry, the same clock that `now()` writes use.
        .andWhere('(k.expires_at IS NULL OR k.expires_at > now())')
        .getOne();
      const user = key?.user;
      if (!key || !user || user.disabled || !user.passwordHash) return null;
      await recordUse(key);
      return { user, keyId: key.id };
    },
  };
}
