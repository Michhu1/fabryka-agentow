import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient, isSessionExpired, onSessionExpired } from './client';

function stubFetch(status: number, body?: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? '' : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('apiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    onSessionExpired(null);
  });

  it('returns parsed JSON on success', async () => {
    stubFetch(200, { a: 1 });
    await expect(apiClient.get<{ a: number }>('/rest/x')).resolves.toEqual({ a: 1 });
  });

  it('throws ApiError with status', async () => {
    stubFetch(404, {});
    const error = await apiClient.get('/rest/missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('a 400 with a body gives the server message and code', async () => {
    stubFetch(400, { message: 'Email already in use' });
    const error = (await apiClient.post('/rest/signup', {}).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Email already in use');
    expect(error.code).toBeUndefined();

    stubFetch(401, { message: 'MFA required', code: 998 });
    const mfa = (await apiClient.post('/rest/login', {}).catch((e: unknown) => e)) as ApiError;
    expect(mfa.code).toBe(998);
  });

  it('keeps extra body fields and survives a body that is not JSON', async () => {
    stubFetch(409, { message: 'User owns team projects', projectCount: 2 });
    const conflict = (await apiClient.delete('/rest/users/1').catch((e: unknown) => e)) as ApiError;
    expect(conflict.body.projectCount).toBe(2);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    const gateway = (await apiClient.get('/rest/x').catch((e: unknown) => e)) as ApiError;
    expect(gateway.status).toBe(502);
    expect(gateway.message).toBe('Request failed with status 502');
  });

  it('a network failure is ApiError status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = (await apiClient.get('/rest/x').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(0);
  });

  it('sends cookies, and JSON Content-Type on every mutating request (DELETE and empty POST too)', async () => {
    const fetchMock = stubFetch(200, {});
    await apiClient.get('/rest/a', { token: 'x y', skip: 0, none: undefined });
    await apiClient.post('/rest/logout');
    await apiClient.patch('/rest/me', { firstName: 'A' });
    await apiClient.put('/rest/x', {});
    await apiClient.delete('/rest/api-keys/1');

    const [getUrl, getInit] = fetchMock.mock.calls[0] ?? [];
    expect(getUrl).toBe('/rest/a?token=x+y&skip=0');
    expect(getInit?.credentials).toBe('include');
    expect(headersOf(getInit)['Content-Type']).toBeUndefined();

    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(init?.credentials).toBe('include');
      expect(headersOf(init)['Content-Type']).toBe('application/json');
    }
    const methods = fetchMock.mock.calls.slice(1).map(([, init]) => init?.method);
    expect(methods).toEqual(['POST', 'PATCH', 'PUT', 'DELETE']);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ firstName: 'A' }));
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{}');
  });

  it('only a 401 "Unauthorized" counts as an expired session', async () => {
    const handler = vi.fn();
    onSessionExpired(handler);

    stubFetch(401, { message: 'Wrong username or password' });
    const wrong = await apiClient.post('/rest/login', {}).catch((e: unknown) => e);
    stubFetch(401, { message: 'Current password is incorrect' });
    const current = await apiClient.patch('/rest/me/password', {}).catch((e: unknown) => e);
    expect(isSessionExpired(wrong)).toBe(false);
    expect(isSessionExpired(current)).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    stubFetch(401, { message: 'Unauthorized' });
    const expired = await apiClient.get('/rest/projects/my-projects').catch((e: unknown) => e);
    expect(isSessionExpired(expired)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
