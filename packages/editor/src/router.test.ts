import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppRouter, reloadOnStaleChunk, safeRedirect, watchSession } from './router';
import { useAuthStore } from './stores/auth';
import { fakeServer, publicUser } from './test/fixtures';

function signedOut() {
  vi.stubGlobal(
    'fetch',
    vi.fn(fakeServer({ 'GET /rest/login': { status: 401, body: { message: 'Unauthorized' } } })),
  );
}
function signedIn() {
  vi.stubGlobal('fetch', vi.fn(fakeServer({ 'GET /rest/login': { status: 200, body: publicUser() } })));
}

async function navigate(path: string) {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  return router;
}

describe('safeRedirect', () => {
  it('accepts only same-site absolute paths', () => {
    expect(safeRedirect('/home')).toBe('/home');
    expect(safeRedirect('/project-invitation?token=abc')).toBe('/project-invitation?token=abc');
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      'https://evil.com',
      'evil.com',
      '',
      '/\t/evil.com',
      undefined,
      null,
      ['/home'],
    ]) {
      expect(safeRedirect(bad), String(bad)).toBeNull();
    }
  });
});

describe('router guards', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('signed out on /home → /signin?redirect=/home', async () => {
    signedOut();
    const router = await navigate('/home');
    expect(router.currentRoute.value.name).toBe('signin');
    expect(router.currentRoute.value.query.redirect).toBe('/home');
  });

  it('signed out deep links (projects, unknown paths) keep the way back', async () => {
    signedOut();
    for (const path of ['/projects/p2/settings', '/does/not/exist']) {
      setActivePinia(createPinia());
      const router = await navigate(path);
      expect(router.currentRoute.value.name).toBe('signin');
      expect(router.currentRoute.value.query.redirect).toBe(path);
    }
  });

  it('public pages stay reachable when signed out', async () => {
    signedOut();
    for (const path of [
      '/signup',
      '/forgot-password',
      '/reset-password?token=x',
      '/accept-invite?token=x',
      '/project-invitation?token=x',
      '/project-transfer?token=x',
    ]) {
      const router = await navigate(path);
      expect(router.currentRoute.value.fullPath).toBe(path);
    }
  });

  it('the plan names of the project link pages work as aliases', async () => {
    signedOut();
    const invite = await navigate('/accept-project-invite?token=x');
    expect(invite.currentRoute.value.name).toBe('project-invitation');
    const transfer = await navigate('/accept-project-transfer?token=x');
    expect(transfer.currentRoute.value.name).toBe('project-transfer');
  });

  it('signed in on /signin → /home, or to a safe redirect; redirect=//evil.com is ignored', async () => {
    signedIn();
    expect((await navigate('/signin')).currentRoute.value.fullPath).toBe('/home');
    setActivePinia(createPinia());
    expect((await navigate('/signin?redirect=%2F%2Fevil.com')).currentRoute.value.fullPath).toBe('/home');
    setActivePinia(createPinia());
    expect(
      (await navigate('/signup?redirect=/project-invitation%3Ftoken%3Dabc')).currentRoute.value.fullPath,
    ).toBe('/project-invitation?token=abc');
  });

  it('signed in: / goes to /home, project pages open, unknown paths show "not found"; link pages stay', async () => {
    signedIn();
    expect((await navigate('/')).currentRoute.value.fullPath).toBe('/home');
    setActivePinia(createPinia());
    expect((await navigate('/projects/p2')).currentRoute.value.name).toBe('project');
    setActivePinia(createPinia());
    expect((await navigate('/projects/p2/settings')).currentRoute.value.name).toBe('project-settings');
    setActivePinia(createPinia());
    const unknown = (await navigate('/does/not/exist')).currentRoute.value;
    expect(unknown.name).toBe('not-found');
    expect(unknown.fullPath).toBe('/does/not/exist');
    setActivePinia(createPinia());
    expect((await navigate('/project-invitation?token=x')).currentRoute.value.name).toBe(
      'project-invitation',
    );
  });

  it('settings: /settings opens personal; users only for the platform owner and admins', async () => {
    const as = (role: 'global:owner' | 'global:admin' | 'global:member') => {
      setActivePinia(createPinia());
      vi.stubGlobal(
        'fetch',
        vi.fn(fakeServer({ 'GET /rest/login': { status: 200, body: publicUser({ role }) } })),
      );
    };
    as('global:member');
    expect((await navigate('/settings')).currentRoute.value.name).toBe('settings-personal');
    as('global:member');
    expect((await navigate('/settings/api')).currentRoute.value.name).toBe('settings-api');
    as('global:member');
    expect((await navigate('/settings/users')).currentRoute.value.name).toBe('settings-personal');
    as('global:admin');
    expect((await navigate('/settings/users')).currentRoute.value.name).toBe('settings-users');
    as('global:owner');
    expect((await navigate('/settings/users')).currentRoute.value.name).toBe('settings-users');
    signedOut();
    setActivePinia(createPinia());
    const out = (await navigate('/settings/users')).currentRoute.value;
    expect(out.name).toBe('signin');
    expect(out.query.redirect).toBe('/settings/users');
  });

  it('when the session ends on a private page, sign-in is shown with a way back', async () => {
    signedIn();
    const router = await navigate('/home');
    watchSession(router);
    useAuthStore().setUser(null);
    await nextTick();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('signin'));
    expect(router.currentRoute.value.query.redirect).toBe('/home');
  });
});

describe('reloadOnStaleChunk', () => {
  const chunkError = () =>
    new TypeError('Failed to fetch dynamically imported module: /assets/ProjectView-old.js');

  function routerWith(load: () => Promise<unknown>, reload: (path: string) => void) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/lazy', component: load as () => Promise<{ default: object }> },
      ],
    });
    reloadOnStaleChunk(router, reload);
    return router;
  }

  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('a chunk of an older build that is gone reloads the page once, at the target path', async () => {
    const reload = vi.fn();
    const router = routerWith(() => Promise.reject(chunkError()), reload);
    await router.push('/lazy?x=1').catch(() => {});
    expect(reload).toHaveBeenCalledExactlyOnceWith('/lazy?x=1');

    // After the reload the chunk still fails (the new build is broken too): no reload loop.
    const reloadAgain = vi.fn();
    const after = routerWith(() => Promise.reject(chunkError()), reloadAgain);
    await after.push('/lazy').catch(() => {});
    expect(reloadAgain).not.toHaveBeenCalled();
  });

  it('a successful navigation allows the next reload (a later deploy)', async () => {
    const reload = vi.fn();
    sessionStorage.setItem('chunk-reload', '1');
    const router = routerWith(() => Promise.reject(chunkError()), reload);
    await router.push('/');
    await router.push('/lazy').catch(() => {});
    expect(reload).toHaveBeenCalledOnce();
  });

  it('other errors do not reload', async () => {
    const reload = vi.fn();
    const router = routerWith(() => Promise.reject(new Error('boom')), reload);
    await router.push('/lazy').catch(() => {});
    expect(reload).not.toHaveBeenCalled();
  });

  it('without sessionStorage (blocked) it never reloads, so it cannot loop', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const reload = vi.fn();
    const router = routerWith(() => Promise.reject(chunkError()), reload);
    await router.push('/lazy').catch(() => {});
    expect(reload).not.toHaveBeenCalled();
  });
});
