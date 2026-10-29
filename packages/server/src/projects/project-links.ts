import { z } from 'zod';
import { sha256 } from '../crypto/password.js';
import type { User } from '../db/entities/user.entity.js';

/**
 * Shape of a project invitation or transfer token: `randomToken(32)` (32 random bytes, base64url).
 * These tokens are not JWTs, so no session, reset or global invitation token can ever pass for one.
 */
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A `token` body field; anything that is not a string answers `message` (like an unknown token). */
export function linkTokenField(message: string) {
  return z.string({ error: message }).max(256, { error: message });
}

/** The stored hash of a well-formed link token, null for anything else (no query needed then). */
export function readLinkToken(token: unknown): string | null {
  return typeof token === 'string' && LINK_TOKEN.test(token) ? sha256(token) : null;
}

/** "Anna Adamska" as shown in mails and on the link's page. */
export function displayName(user: Pick<User, 'firstName' | 'lastName'>): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

/**
 * SQL: the sender of the transfer row `alias` still owns its project. Without it a transfer link stops
 * working (its page, and signing up from it, say "invalid") — the same condition everywhere.
 */
export function transferSenderIsOwnerSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM project_relation sender_rel
    WHERE sender_rel.project_id = ${alias}.project_id AND sender_rel.user_id = ${alias}.from_user_id
      AND sender_rel.role = 'project:admin'
  )`;
}

/**
 * SQL columns about the account of the link's address (`email`), for the link holder only:
 * `hasAccount` — an active account (sign in); `pendingInvite` — an account invited to the platform that
 * never set a password (it must accept that invitation first: signing up would fail). A disabled
 * account is neither, so it looks exactly like an address without an account.
 */
export function linkAccountColumnsSql(email: string): string {
  return `EXISTS (
      SELECT 1 FROM "user" a WHERE a.email = ${email} AND NOT a.disabled AND a.password_hash IS NOT NULL
    ) AS "hasAccount",
    EXISTS (
      SELECT 1 FROM "user" a WHERE a.email = ${email} AND NOT a.disabled AND a.password_hash IS NULL
    ) AS "pendingInvite"`;
}
