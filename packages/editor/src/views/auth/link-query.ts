import type { LocationQuery, Router } from 'vue-router';
import { safeRedirect } from '../../router';

/** A query value as one string (the first one if repeated), null when absent or empty. */
export function queryString(value: LocationQuery[string] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : null;
}

/**
 * The query the sign-in and sign-up pages hand to each other: the email and invitation token of an
 * invitation or transfer link, and where to go afterwards.
 */
export function authLinkQuery(query: LocationQuery): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['email', 'inviteToken', 'redirect']) {
    const value = queryString(query[key]);
    if (value) result[key] = value;
  }
  return result;
}

/** Whether `redirect` leads back to a project invitation or transfer link page. */
export function isProjectLinkRedirect(router: Router, redirect: unknown): boolean {
  const target = safeRedirect(redirect);
  if (!target) return false;
  const name = router.resolve(target).name;
  return name === 'project-invitation' || name === 'project-transfer';
}
