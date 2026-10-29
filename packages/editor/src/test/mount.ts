import type { PublicUser } from '@app/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Component } from 'vue';
import { createMemoryHistory, type Router } from 'vue-router';
import { i18n } from '../i18n';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';

/**
 * Mounts a view with pinia, the app router (memory history, already at `path`) and i18n. `user` is the
 * signed-in user (null = signed out); no `GET /rest/login` is made for it. `attach` mounts into
 * `document.body` — needed when the test opens a dialog or menu (reka-ui teleports them to <body>).
 */
export async function mountView(
  component: Component,
  options: {
    path?: string;
    user?: PublicUser | null;
    props?: Record<string, unknown>;
    attach?: boolean;
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.setUser(options.user ?? null);
  const router = createAppRouter(createMemoryHistory());
  await preloadPages(router);
  await router.push(options.path ?? '/');
  await router.isReady();
  const wrapper = mount(component, {
    props: options.props,
    attachTo: options.attach ? document.body : undefined,
    global: { plugins: [pinia, router, i18n] },
  });
  await flushPromises();
  return { wrapper, router, auth };
}

/**
 * Loads every lazy page (`() => import(...)`) up front. Otherwise a test that navigates (e.g. sign-in →
 * `/home`) waits for the first, cold compile of the next page, which with many test files in parallel on
 * a slower machine takes longer than `vi.waitFor`'s 1 s — and can finish after the test file has ended.
 */
async function preloadPages(router: Router) {
  const lazy = router
    .getRoutes()
    .flatMap((route) => Object.values(route.components ?? {}))
    .filter((page): page is () => Promise<unknown> => typeof page === 'function');
  await Promise.all(lazy.map((load) => load()));
}
