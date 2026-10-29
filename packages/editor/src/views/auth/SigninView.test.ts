import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import SigninView from './SigninView.vue';

function stubLogin() {
  const fetchMock = vi.fn(
    fakeServer({
      'POST /rest/login': (init) => {
        const body = sentBody(init);
        if (body.password !== 'Haslo123')
          return { status: 401, body: { message: 'Wrong username or password' } };
        if (body.mfaCode === '123456' || body.mfaRecoveryCode === 'abcd-efgh')
          return { status: 200, body: publicUser({ mfaEnabled: true }) };
        if (body.mfaCode || body.mfaRecoveryCode)
          return { status: 401, body: { message: 'Invalid two-factor code' } };
        return { status: 401, body: { message: 'MFA required', code: 998 } };
      },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function signIn(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper'], password = 'Haslo123') {
  await wrapper.get('input[type="email"]').setValue('jan@firma.pl');
  await wrapper.get('input[type="password"]').setValue(password);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
}

describe('SigninView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('wrong password → Polish error, still on the form', async () => {
    stubLogin();
    const { wrapper } = await mountView(SigninView, { path: '/signin' });
    await signIn(wrapper, 'zle');
    expect(wrapper.text()).toContain('Nieprawidłowy e-mail lub hasło.');
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  });

  it('code 998 shows "Kod z aplikacji"; the second submit sends mfaCode and goes to the redirect', async () => {
    const fetchMock = stubLogin();
    const { wrapper, router, auth } = await mountView(SigninView, { path: '/signin?redirect=/home' });
    await signIn(wrapper);

    expect(wrapper.text()).toContain('Kod z aplikacji');
    expect(auth.user).toBeNull();
    await wrapper.get('input[autocomplete="one-time-code"]').setValue('654321');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Nieprawidłowy kod.');

    await wrapper.get('input[autocomplete="one-time-code"]').setValue('123456');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(sentBody(fetchMock.mock.calls.at(-1)?.[1])).toEqual({
      email: 'jan@firma.pl',
      password: 'Haslo123',
      mfaCode: '123456',
    });
    expect(auth.user?.email).toBe('jan@firma.pl');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/home'));
  });

  it('"use a recovery code" sends mfaRecoveryCode instead', async () => {
    const fetchMock = stubLogin();
    const { wrapper } = await mountView(SigninView, { path: '/signin' });
    await signIn(wrapper);
    const toggle = wrapper.findAll('button').find((b) => b.text().includes('kodu odzyskiwania'));
    await toggle?.trigger('click');
    expect(wrapper.text()).toContain('Kod odzyskiwania');
    await wrapper.get('input[autocomplete="off"]').setValue('abcd-efgh');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const body = sentBody(fetchMock.mock.calls.at(-1)?.[1]);
    expect(body.mfaRecoveryCode).toBe('abcd-efgh');
    expect(body.mfaCode).toBeUndefined();
  });

  it('an email from the link is prefilled and locked; links keep the redirect', async () => {
    stubLogin();
    const { wrapper, router } = await mountView(SigninView, {
      path: '/signin?email=nowy%40firma.pl&redirect=%2Fproject-invitation%3Ftoken%3Dabc',
    });
    const email = wrapper.get('input[type="email"]');
    expect((email.element as HTMLInputElement).value).toBe('nowy@firma.pl');
    expect(email.attributes('readonly')).toBeDefined();
    const signup = wrapper.findAll('a').find((a) => a.text() === 'Załóż konto');
    expect(router.resolve(signup?.attributes('href') ?? '').query).toEqual({
      email: 'nowy@firma.pl',
      redirect: '/project-invitation?token=abc',
    });
  });

  it('?email= without a project link redirect is prefilled but stays editable', async () => {
    stubLogin();
    for (const path of ['/signin?email=jan%40firma.pl', '/signin?email=jan%40firma.pl&redirect=%2Fhome']) {
      const { wrapper } = await mountView(SigninView, { path });
      const email = wrapper.get('input[type="email"]');
      expect((email.element as HTMLInputElement).value, path).toBe('jan@firma.pl');
      expect(email.attributes('readonly'), path).toBeUndefined();
      wrapper.unmount();
    }
  });

  it('a project transfer link (also by its alias) locks the email too', async () => {
    stubLogin();
    const { wrapper } = await mountView(SigninView, {
      path: '/signin?email=nowy%40firma.pl&redirect=%2Faccept-project-transfer%3Ftoken%3Dabc',
    });
    expect(wrapper.get('input[type="email"]').attributes('readonly')).toBeDefined();
  });

  it('fields carry names and autocomplete for password managers', async () => {
    stubLogin();
    const { wrapper } = await mountView(SigninView, { path: '/signin' });
    const email = wrapper.get('input[type="email"]');
    expect(email.attributes('name')).toBe('email');
    expect(email.attributes('autocomplete')).toBe('email');
    const password = wrapper.get('input[type="password"]');
    expect(password.attributes('name')).toBe('password');
    expect(password.attributes('autocomplete')).toBe('current-password');
    await signIn(wrapper);
    expect(wrapper.get('input[autocomplete="one-time-code"]').attributes('name')).toBe('mfaCode');
  });
});
