import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@app/config';
import type { GlobalRole } from '@app/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { DataSource } from 'typeorm';
import { deriveKey } from '../crypto/keys.js';
import { sha256 } from '../crypto/password.js';
import { InvalidAuthToken } from '../db/entities/invalid-auth-token.entity.js';
import { User } from '../db/entities/user.entity.js';
import { describeError } from '../describe-error.js';
import { HttpError } from '../http/errors.js';

declare global {
  namespace Express {
    interface Request {
      /** The signed-in user; set by `authenticate`. */
      user?: User;
    }
  }
}

export const AUTH_COOKIE = 'moj-n8n-auth';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A cookie with less than this left is replaced by a fresh one on the next authenticated request. */
const REFRESH_BELOW_SECONDS = 24 * 60 * 60;
/** Shape of a user id; checked before a token's `sub` reaches a query. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id from the URL in the form the database returns it (lowercase). PostgreSQL accepts a uuid in
 * capitals, but ids are also compared as strings (e.g. "is this my own membership?"), so routes
 * normalize them once, on the way in.
 */
export function normalizeId(id: string): string {
  return id.toLowerCase();
}

/** Verified content of a session token. */
export type SessionPayload = { sub: string; h: string; jti: string; exp: number };

export type SessionDeps = { dataSource: DataSource; config: AppConfig };

/**
 * Fingerprint of the credentials the token was issued for: a change of email or password changes it,
 * which invalidates every older session of that user without storing anything.
 */
export function sessionHash(user: Pick<User, 'email' | 'passwordHash'>): string {
  return sha256(`${user.email}:${user.passwordHash ?? ''}`).slice(0, 10);
}

/**
 * Key for every JWT the server issues (session, password reset, invitation). Since they share it, each
 * verifier must accept only its own claim shape, so one kind of token never works as another.
 */
export function jwtKey(config: AppConfig): Buffer {
  return deriveKey(config.encryptionKey, 'auth-jwt');
}

function cookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.editorBaseUrl.startsWith('https://'),
    path: '/',
  };
}

/** Signs a new 7-day session token for `user` and sets it as the auth cookie. */
export function issueSession(res: Response, user: User, config: AppConfig): void {
  const token = jwt.sign({ sub: user.id, h: sessionHash(user), jti: randomUUID() }, jwtKey(config), {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SECONDS,
  });
  res.cookie(AUTH_COOKIE, token, { ...cookieOptions(config), maxAge: SESSION_TTL_SECONDS * 1000 });
}

/** The verified payload of the request's session cookie (signature + expiry only), or null. */
export function readSessionToken(req: Request, config: AppConfig): SessionPayload | null {
  const token: unknown = req.cookies?.[AUTH_COOKIE];
  if (typeof token !== 'string' || token === '') return null;
  try {
    const payload = jwt.verify(token, jwtKey(config), { algorithms: ['HS256'] });
    if (typeof payload !== 'object') return null;
    const { sub, h, jti, exp } = payload as Partial<SessionPayload>;
    if (typeof sub !== 'string' || !UUID.test(sub) || typeof h !== 'string' || typeof jti !== 'string')
      return null;
    if (typeof exp !== 'number') return null;
    // Reset and invitation tokens share the key; one carrying their claims is never a session.
    if ('ph' in payload || 'inv' in payload) return null;
    return { sub, h, jti, exp };
  } catch {
    return null;
  }
}

function revokedTokenHash(jti: string): string {
  return sha256(jti);
}

/**
 * Requires a valid session: signed, not expired, not logged out, for an active user with a password
 * whose credentials still match the token. Sets `req.user`; otherwise 401 `Unauthorized`.
 */
export function authenticate(deps: SessionDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const payload = readSessionToken(req, deps.config);
    if (!payload) return next(new HttpError(401, 'Unauthorized'));
    // One round trip for the user row and the logout check (this runs on every authenticated request).
    const { entities, raw } = await deps.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .addSelect('EXISTS (SELECT 1 FROM invalid_auth_token t WHERE t.token_hash = :tokenHash)', 'revoked')
      .where('u.id = :id', { id: payload.sub, tokenHash: revokedTokenHash(payload.jti) })
      .getRawAndEntities<{ revoked: boolean }>();
    const user = entities[0];
    const revoked = raw[0]?.revoked !== false;
    if (!user || user.disabled || !user.passwordHash || revoked || sessionHash(user) !== payload.h) {
      return next(new HttpError(401, 'Unauthorized'));
    }
    if (payload.exp - Date.now() / 1000 < REFRESH_BELOW_SECONDS) issueSession(res, user, deps.config);
    recordActivity(deps.dataSource, user);
    req.user = user;
    next();
  };
}

/**
 * Sets `last_active_at` to the current UTC day, at most one write per user and day: the date is
 * already on the loaded row, so on every other request this costs nothing. Not awaited — a failed
 * write must neither slow down nor break the request; it is logged without the query's parameters.
 */
function recordActivity(dataSource: DataSource, user: User): void {
  const today = new Date().toISOString().slice(0, 10);
  if (user.lastActiveAt === today) return;
  user.lastActiveAt = today;
  dataSource
    .query(
      `UPDATE "user" SET last_active_at = $2::date WHERE id = $1 AND last_active_at IS DISTINCT FROM $2::date`,
      [user.id, today],
    )
    .catch((error: unknown) => {
      console.error(`Last activity of user ${user.id} could not be recorded (${describeError(error)})`);
    });
}

/**
 * For routes behind `authenticate`: 403 `Forbidden` unless the user has one of the instance roles.
 * Instance roles manage accounts only; they never open other users' projects (privacy rule).
 */
export function requireGlobalRole(...roles: GlobalRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Unauthorized'));
    if (!roles.includes(user.role)) return next(new HttpError(403, 'Forbidden'));
    next();
  };
}

/** `req.user` for handlers mounted behind `authenticate`. */
export function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Unauthorized');
  return req.user;
}

/**
 * Logout: remembers the token id as revoked until the token would expire anyway and clears the cookie.
 * Only verified tokens are stored, so forged cookies cannot fill the table.
 */
export async function revokeSession(req: Request, res: Response, deps: SessionDeps): Promise<void> {
  const payload = readSessionToken(req, deps.config);
  if (payload) {
    await deps.dataSource
      .getRepository(InvalidAuthToken)
      .createQueryBuilder()
      .insert()
      .values({ tokenHash: revokedTokenHash(payload.jti), expiresAt: new Date(payload.exp * 1000) })
      .orIgnore()
      .execute();
    // Revoked tokens are only needed until they would expire anyway; logout is a natural moment to prune.
    await deps.dataSource.query(`DELETE FROM invalid_auth_token WHERE expires_at < now()`);
  }
  res.clearCookie(AUTH_COOKIE, cookieOptions(deps.config));
}
