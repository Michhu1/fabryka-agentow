import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '../api/client';
import { fakeServer, publicUser, sentBody } from '../test/fixtures';
import { useAuthStore } from './auth';

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('init() with 401 → user null, initialized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/login': { status: 401, body: { message: 'Unauthorized' } } })),
    );
    const auth = useAuthStore();
    await auth.init();
    expect(auth.user).toBeNull();
    expect(auth.initialized).toBe(true);
  });

  it('init() with a session → user; called twice, asks the server once', async () => {
    const fetchMock = vi.fn(fakeServer({ 'GET /rest/login': { status: 200, body: publicUser() } }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = useAuthStore();
    await Promise.all([auth.init(), auth.init()]);
    expect(auth.user?.email).toBe('jan@firma.pl');
    expect(auth.isSignedIn).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('init() with 401 is not "offline"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/login': { status: 401, body: { message: 'Unauthorized' } } })),
    );
    const auth = useAuthStore();
    await auth.init();
    expect(auth.offline).toBe(false);
  });

  it('init() with a network error → no user, initialized, but offline (not "signed out")', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const auth = useAuthStore();
    await auth.init();
    expect(auth.user).toBeNull();
    expect(auth.initialized).toBe(true);
    expect(auth.offline).toBe(true);
  });

  it('init() with a 5xx → offline; retry() asks again and clears it', async () => {
    let up = false;
    const fetchMock = vi.fn(
      fakeServer({
        'GET /rest/login': () =>
          up
            ? { status: 200, body: publicUser() }
            : { status: 503, body: { message: 'Service unavailable' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = useAuthStore();
    await auth.init();
    expect(auth.offline).toBe(true);
    expect(auth.user).toBeNull();

    // Still down: stays offline.
    await auth.retry();
    expect(auth.offline).toBe(true);

    up = true;
    await auth.retry();
    expect(auth.offline).toBe(false);
    expect(auth.user?.email).toBe('jan@firma.pl');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('login() sends the MFA code and stores the user; 998 is thrown to the view', async () => {
    const fetchMock = vi.fn(
      fakeServer({
        'POST /rest/login': (init) =>
          sentBody(init).mfaCode
            ? { status: 200, body: publicUser({ mfaEnabled: true }) }
            : { status: 401, body: { message: 'MFA required', code: 998 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = useAuthStore();
    const error = (await auth.login('jan@firma.pl', 'Haslo123').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(998);
    expect(auth.user).toBeNull();

    await auth.login('jan@firma.pl', 'Haslo123', { mfaCode: '123456' });
    expect(auth.user?.mfaEnabled).toBe(true);
    expect(sentBody(fetchMock.mock.calls[1]?.[1])).toEqual({
      email: 'jan@firma.pl',
      password: 'Haslo123',
      mfaCode: '123456',
    });
  });

  it('signup() passes the invite token; logout() clears the user even if the request fails', async () => {
    const fetchMock = vi.fn(
      fakeServer({
        'POST /rest/signup': { status: 200, body: publicUser() },
        'POST /rest/logout': { status: 500, body: { message: 'Internal server error' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = useAuthStore();
    await auth.signup({
      email: 'jan@firma.pl',
      firstName: 'Jan',
      lastName: 'Kowalski',
      password: 'Haslo123',
      inviteToken: 'tok',
    });
    expect(sentBody(fetchMock.mock.calls[0]?.[1]).inviteToken).toBe('tok');
    expect(auth.user).not.toBeNull();
    await auth.logout();
    expect(auth.user).toBeNull();
  });

  it('a 401 other than "Unauthorized" never signs the user out; "Unauthorized" does', async () => {
    let answer = { status: 401, body: { message: 'Current password is incorrect' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/login': { status: 200, body: publicUser() },
          'PATCH /rest/me/password': () => answer,
        }),
      ),
    );
    const auth = useAuthStore();
    await auth.init();
    await apiClient.patch('/rest/me/password', {}).catch(() => undefined);
    expect(auth.user).not.toBeNull();

    answer = { status: 401, body: { message: 'Unauthorized' } };
    await apiClient.patch('/rest/me/password', {}).catch(() => undefined);
    expect(auth.user).toBeNull();
  });

  it('refresh() and setUser() update the user for later screens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/login': { status: 200, body: publicUser({ ownedTeamProjects: 2 }) } })),
    );
    const auth = useAuthStore();
    auth.setUser(publicUser());
    expect(auth.user?.ownedTeamProjects).toBe(0);
    await auth.refresh();
    expect(auth.user?.ownedTeamProjects).toBe(2);
  });

  it('atTeamProjectLimit: owning as many team projects as the limit allows', () => {
    const auth = useAuthStore();
    auth.setUser(publicUser({ ownedTeamProjects: 2, teamProjectsLimit: 3 }));
    expect(auth.atTeamProjectLimit).toBe(false);
    auth.setUser(publicUser({ ownedTeamProjects: 3, teamProjectsLimit: 3 }));
    expect(auth.atTeamProjectLimit).toBe(true);
    auth.setUser(publicUser({ ownedTeamProjects: 0, teamProjectsLimit: 0 }));
    expect(auth.atTeamProjectLimit).toBe(true);
  });
});
