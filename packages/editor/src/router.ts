import type { GlobalRole } from '@app/shared';
import { watch } from 'vue';
import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';
import { useAuthStore } from './stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without signing in. */
    public?: boolean;
    /** Only for signed-out visitors (sign-in, sign-up…): a signed-in user is sent on to the app. */
    guestOnly?: boolean;
    /** Only for these instance roles; anyone else is sent to their personal settings. */
    globalRoles?: GlobalRole[];
  }
}

const HOME = '/home';

/**
 * A `redirect` query value we may navigate to: only a path on this site (`/…`), never `//host` or
 * `/\host` (browsers read both as another host) and nothing with control characters (browsers drop
 * tabs and newlines, so `/\t/host` would become `//host`).
 */
export function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  if (value[1] === '/' || value[1] === '\\') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: HOME },
      {
        // The signed-in app: sidebar on the left, the page on the right.
        path: '/',
        component: () => import('./layouts/MainLayout.vue'),
        children: [
          { path: 'home', name: 'home', component: () => import('./views/OverviewView.vue') },
          {
            path: 'projects/:projectId',
            name: 'project',
            component: () => import('./views/ProjectView.vue'),
          },
          {
            path: 'projects/:projectId/settings',
            name: 'project-settings',
            component: () => import('./views/ProjectSettingsView.vue'),
          },
          // Unknown paths: a "not found" page in the app (signed-out visitors sign in first and come back).
          { path: ':pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue') },
        ],
      },
      {
        // Settings: their own menu instead of the sidebar (like n8n), with a way back to the app.
        path: '/settings',
        component: () => import('./layouts/SettingsLayout.vue'),
        children: [
          { path: '', redirect: { name: 'settings-personal' } },
          {
            path: 'personal',
            name: 'settings-personal',
            component: () => import('./views/settings/PersonalSettingsView.vue'),
          },
          {
            path: 'users',
            name: 'settings-users',
            component: () => import('./views/settings/UsersSettingsView.vue'),
            meta: { globalRoles: ['global:owner', 'global:admin'] },
          },
          {
            path: 'api',
            name: 'settings-api',
            component: () => import('./views/settings/ApiKeysSettingsView.vue'),
          },
        ],
      },
      {
        path: '/signin',
        name: 'signin',
        component: () => import('./views/auth/SigninView.vue'),
        meta: { public: true, guestOnly: true },
      },
      {
        path: '/signup',
        name: 'signup',
        component: () => import('./views/auth/SignupView.vue'),
        meta: { public: true, guestOnly: true },
      },
      {
        path: '/forgot-password',
        name: 'forgot-password',
        component: () => import('./views/auth/ForgotPasswordView.vue'),
        meta: { public: true, guestOnly: true },
      },
      {
        path: '/reset-password',
        name: 'reset-password',
        component: () => import('./views/auth/ResetPasswordView.vue'),
        meta: { public: true },
      },
      {
        path: '/accept-invite',
        name: 'accept-invite',
        component: () => import('./views/auth/AcceptInviteView.vue'),
        meta: { public: true },
      },
      // The paths of the links the server mails (`/project-invitation?token=`, `/project-transfer?token=`);
      // the aliases are the names used in the M1 plan.
      {
        path: '/project-invitation',
        alias: '/accept-project-invite',
        name: 'project-invitation',
        component: () => import('./views/auth/ProjectLinkView.vue'),
        props: { kind: 'invitation' },
        meta: { public: true },
      },
      {
        path: '/project-transfer',
        alias: '/accept-project-transfer',
        name: 'project-transfer',
        component: () => import('./views/auth/ProjectLinkView.vue'),
        props: { kind: 'transfer' },
        meta: { public: true },
      },
    ],
  });

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    await auth.init();
    // The session is unknown (server unreachable): the app shows the offline screen over any page, and
    // its "Spróbuj ponownie" runs this guard again.
    if (auth.offline) return true;
    if (to.meta.public) {
      if (to.meta.guestOnly && auth.isSignedIn) return safeRedirect(to.query.redirect) ?? HOME;
      return true;
    }
    if (!auth.isSignedIn) return { name: 'signin', query: { redirect: to.fullPath } };
    const roles = to.meta.globalRoles;
    if (roles && auth.user && !roles.includes(auth.user.role)) return { name: 'settings-personal' };
    return true;
  });

  return router;
}

const CHUNK_RELOAD_KEY = 'chunk-reload';

/** The browsers' messages for a lazy page (`import()`) whose file could not be loaded. */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    error.message,
  );
}

/**
 * After a deploy the files of the previous build are gone, so a tab opened before it fails to load the
 * next page. Then the page is loaded again (once) at the place the user was going, with the new build.
 * A flag in sessionStorage stops a reload loop when even the new build fails; it is cleared by the next
 * successful navigation. Without sessionStorage (blocked) there is no reload at all, for the same reason.
 */
export function reloadOnStaleChunk(
  router: Router,
  reload: (path: string) => void = (path) => window.location.assign(path),
): void {
  router.onError((error, to) => {
    if (!isChunkLoadError(error)) return;
    try {
      if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return;
      sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
    } catch {
      return;
    }
    reload(to.fullPath);
  });
  router.afterEach((_to, _from, failure) => {
    if (failure) return;
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    } catch {
      // Storage blocked: nothing to clear.
    }
  });
}

/**
 * Shows sign-in as soon as the user is signed out while on a private page: after "Wyloguj się", or
 * when an API answer says the session is gone (then with `redirect` back to where they were).
 */
export function watchSession(router: Router): void {
  const auth = useAuthStore();
  watch(
    () => auth.user,
    (user) => {
      const route = router.currentRoute.value;
      if (user || route.meta.public || !auth.initialized) return;
      const query = auth.signedOutByUser ? {} : { redirect: route.fullPath };
      void router.push({ name: 'signin', query });
    },
  );
}
