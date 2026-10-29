import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from './App.vue';
import { i18n } from './i18n';
import { createAppRouter } from './router';
import { fakeServer } from './test/fixtures';

/** The whole app at `path`, with the real start-up (`GET /rest/login` from the router guard). */
async function mountApp(path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] } });
  await router.push(path);
  await flushPromises();
  return { wrapper, router };
}

describe('App start-up', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('server unreachable → "Nie można połączyć się z serwerem", not sign-in; retry then decides', async () => {
    let answer: 'down' | 'signed-out' = 'down';
    const fetchMock = vi.fn(
      fakeServer({
        'GET /rest/login': () =>
          answer === 'down'
            ? { status: 502, body: { message: 'Bad gateway' } }
            : { status: 401, body: { message: 'Unauthorized' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper, router } = await mountApp('/projects/p2');
    expect(wrapper.text()).toContain('Nie można połączyć się z serwerem');
    expect(wrapper.text()).not.toContain('Witaj ponownie');
    expect(router.currentRoute.value.name).toBe('project');

    // Still down: the screen stays.
    await wrapper.get('[data-test="retry"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Nie można połączyć się z serwerem');

    answer = 'signed-out';
    await wrapper.get('[data-test="retry"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('signin'));
    expect(router.currentRoute.value.query).toEqual({ redirect: '/projects/p2' });
    expect(wrapper.text()).not.toContain('Nie można połączyć się z serwerem');
  });

  it('401 at start → sign-in straight away', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/login': { status: 401, body: { message: 'Unauthorized' } } })),
    );
    const { wrapper, router } = await mountApp('/home');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('signin'));
    expect(wrapper.text()).not.toContain('Nie można połączyć się z serwerem');
  });
});
