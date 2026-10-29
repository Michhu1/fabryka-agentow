import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { i18n } from './index';
import pl from './pl.json';
import { serverErrorKey } from './server-errors';

function hasKey(key: string): boolean {
  let node: unknown = pl;
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === 'string';
}

describe('serverErrorKey', () => {
  it('maps server messages to Polish texts', () => {
    const t = i18n.global.t;
    expect(t(serverErrorKey(new ApiError(400, 'Email already in use')))).toContain('już istnieje');
    expect(serverErrorKey(new ApiError(401, 'Wrong username or password'))).toBe('errors.wrongCredentials');
    expect(serverErrorKey(new ApiError(400, 'API key limit reached (10)'))).toBe('errors.apiKeyLimit');
    expect(serverErrorKey(new ApiError(400, 'You cannot disable your own account'))).toBe(
      'errors.ownAccount',
    );
    expect(serverErrorKey(new ApiError(429, 'Too many requests'))).toBe('errors.tooManyRequests');
    expect(serverErrorKey(new ApiError(0, 'Network error'))).toBe('common.networkError');
  });

  it('session, request-shape and role/theme messages', () => {
    const t = i18n.global.t;
    expect(t(serverErrorKey(new ApiError(401, 'Unauthorized')))).toBe('Sesja wygasła, zaloguj się ponownie.');
    expect(serverErrorKey(new ApiError(503, 'Service unavailable'))).toBe('errors.serviceUnavailable');
    for (const message of [
      'Invalid JSON body',
      'Invalid request body',
      'Content-Type must be application/json',
      'Unknown field: role',
      'Unknown field: x',
    ]) {
      expect(serverErrorKey(new ApiError(400, message)), message).toBe('errors.invalidRequest');
    }
    expect(serverErrorKey(new ApiError(400, 'Role must be project:editor or project:viewer'))).toBe(
      'errors.invalidProjectRole',
    );
    expect(serverErrorKey(new ApiError(400, 'Role must be global:admin or global:member'))).toBe(
      'errors.invalidGlobalRole',
    );
    expect(serverErrorKey(new ApiError(400, 'Theme must be system, light or dark'))).toBe(
      'errors.invalidTheme',
    );
  });

  it('anything unknown → common.unexpectedError', () => {
    expect(serverErrorKey(new ApiError(500, 'Internal server error'))).toBe('common.unexpectedError');
    expect(serverErrorKey(new ApiError(409, 'Busy'))).toBe('common.unexpectedError');
    expect(serverErrorKey(new Error('boom'))).toBe('common.unexpectedError');
  });

  it('every mapped key exists in pl.json', async () => {
    const source = await import('./server-errors?raw');
    const keys = [...(source.default as string).matchAll(/'((?:errors|common)\.\w+)'/g)].map(
      (m) => m[1] ?? '',
    );
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) expect(hasKey(key), key).toBe(true);
  });
});
