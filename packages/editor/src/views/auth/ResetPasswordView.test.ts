import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import ResetPasswordView from './ResetPasswordView.vue';

const PATH = '/reset-password?token=reset.jwt.token';

type Wrapper = Awaited<ReturnType<typeof mountView>>['wrapper'];

async function fill(wrapper: Wrapper, password: string, confirm = password) {
  await wrapper.get('input[name="password"]').setValue(password);
  await wrapper.get('input[name="passwordConfirm"]').setValue(confirm);
}

const changeCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => url === '/rest/change-password');

describe('ResetPasswordView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('without 2FA: checks the policy and the repeat, then saves, signs in and opens the app', async () => {
    const fetchMock = vi.fn(
      fakeServer({
        'GET /rest/resolve-password-token': { status: 200, body: { mfaRequired: false } },
        'POST /rest/change-password': { status: 200, body: publicUser() },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper, router, auth } = await mountView(ResetPasswordView, { path: PATH });
    expect(wrapper.find('input[autocomplete="one-time-code"]').exists()).toBe(false);

    await fill(wrapper, 'krotkie');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Hasło musi mieć 8–64 znaki');
    await fill(wrapper, 'NoweHaslo1', 'NoweHaslo2');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Hasła nie są takie same.');
    expect(changeCalls(fetchMock)).toHaveLength(0);

    await fill(wrapper, 'NoweHaslo1');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(sentBody(changeCalls(fetchMock)[0]?.[1])).toEqual({
      token: 'reset.jwt.token',
      password: 'NoweHaslo1',
    });
    expect(auth.user?.email).toBe('jan@firma.pl');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/home'));
  });

  it('998 although the link said no 2FA (turned on meanwhile) → asks for the code and sends it', async () => {
    const fetchMock = vi.fn(
      fakeServer({
        'GET /rest/resolve-password-token': { status: 200, body: { mfaRequired: false } },
        'POST /rest/change-password': (init) =>
          sentBody(init).mfaCode === '123456'
            ? { status: 200, body: publicUser({ mfaEnabled: true }) }
            : { status: 400, body: { message: 'MFA required', code: 998 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper, router } = await mountView(ResetPasswordView, { path: PATH });
    await fill(wrapper, 'NoweHaslo1');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Wpisz kod weryfikacji dwuetapowej.');
    expect(wrapper.text()).toContain('Twoje konto ma weryfikację dwuetapową');
    const code = wrapper.get('input[autocomplete="one-time-code"]');
    expect(code.attributes('name')).toBe('mfaCode');
    await code.setValue(' 123456 ');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(sentBody(changeCalls(fetchMock).at(-1)?.[1])).toEqual({
      token: 'reset.jwt.token',
      password: 'NoweHaslo1',
      mfaCode: '123456',
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/home'));
  });

  it('with 2FA from the start: the code field is shown; a wrong code is a form error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/resolve-password-token': { status: 200, body: { mfaRequired: true } },
          'POST /rest/change-password': { status: 400, body: { message: 'Invalid two-factor code' } },
        }),
      ),
    );
    const { wrapper, auth } = await mountView(ResetPasswordView, { path: PATH });
    expect(wrapper.find('input[autocomplete="one-time-code"]').exists()).toBe(true);
    await fill(wrapper, 'NoweHaslo1');
    await wrapper.get('input[autocomplete="one-time-code"]').setValue('000000');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Nieprawidłowy kod.');
    expect(auth.user).toBeNull();
  });

  it('an invalid or expired link → message and "Wyślij nowy link"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/resolve-password-token': {
            status: 400,
            body: { message: 'Invalid password reset token' },
          },
        }),
      ),
    );
    const { wrapper, router } = await mountView(ResetPasswordView, { path: PATH });
    expect(wrapper.text()).toContain('Ten link do zmiany hasła jest nieważny albo wygasł.');
    expect(wrapper.find('form').exists()).toBe(false);
    const link = wrapper.findAll('a').find((a) => a.text() === 'Wyślij nowy link');
    expect(router.resolve(link?.attributes('href') ?? '').name).toBe('forgot-password');
  });

  it('the token dies while the form is open (used elsewhere) → the invalid message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/resolve-password-token': { status: 200, body: { mfaRequired: false } },
          'POST /rest/change-password': { status: 400, body: { message: 'Invalid password reset token' } },
        }),
      ),
    );
    const { wrapper } = await mountView(ResetPasswordView, { path: PATH });
    await fill(wrapper, 'NoweHaslo1');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Ten link do zmiany hasła jest nieważny albo wygasł.');
  });
});
