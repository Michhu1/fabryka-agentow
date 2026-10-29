import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import AcceptInviteView from './AcceptInviteView.vue';

const PATH = '/accept-invite?token=jwt.token.here';

function stub(routes: Parameters<typeof fakeServer>[0] = {}) {
  const fetchMock = vi.fn(
    fakeServer({
      'GET /rest/invitations/resolve': {
        status: 200,
        body: { email: 'nowy@firma.pl', inviterName: 'Olga Owczarek' },
      },
      'POST /rest/invitations/accept': { status: 200, body: publicUser({ email: 'nowy@firma.pl' }) },
      ...routes,
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AcceptInviteView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the inviter and the locked address; checks the password policy before sending', async () => {
    const fetchMock = stub();
    const { wrapper } = await mountView(AcceptInviteView, { path: PATH });
    expect(wrapper.text()).toContain('Olga Owczarek zaprasza Cię do platformy.');
    const email = wrapper.get('input[type="email"]');
    expect((email.element as HTMLInputElement).value).toBe('nowy@firma.pl');
    expect(email.attributes('readonly')).toBeDefined();

    await wrapper.get('input[name="firstName"]').setValue('Nowy');
    await wrapper.get('input[name="lastName"]').setValue('Gość');
    await wrapper.get('input[type="password"]').setValue('slabe');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Hasło musi mieć 8–64 znaki');
    expect(fetchMock.mock.calls.some(([url]) => url === '/rest/invitations/accept')).toBe(false);
  });

  it('accepting signs in and opens the app', async () => {
    const fetchMock = stub();
    const { wrapper, router, auth } = await mountView(AcceptInviteView, { path: PATH });
    await wrapper.get('input[name="firstName"]').setValue('Nowy');
    await wrapper.get('input[name="lastName"]').setValue('Gość');
    await wrapper.get('input[type="password"]').setValue('Haslo123');
    expect(wrapper.get('input[type="password"]').attributes('autocomplete')).toBe('new-password');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const call = fetchMock.mock.calls.find(([url]) => url === '/rest/invitations/accept');
    expect(sentBody(call?.[1])).toEqual({
      token: 'jwt.token.here',
      firstName: 'Nowy',
      lastName: 'Gość',
      password: 'Haslo123',
    });
    expect(auth.user?.email).toBe('nowy@firma.pl');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/home'));
  });

  it('an invalid or used link → a message and a way to sign in', async () => {
    stub({ 'GET /rest/invitations/resolve': { status: 400, body: { message: 'Invalid invitation token' } } });
    const { wrapper, router } = await mountView(AcceptInviteView, { path: PATH });
    expect(wrapper.text()).toContain('To zaproszenie jest nieważne, wygasło albo zostało już przyjęte.');
    expect(wrapper.find('form').exists()).toBe(false);
    const link = wrapper.get('[data-test="signin-link"]');
    expect(router.resolve(link.attributes('href') ?? '').name).toBe('signin');
  });

  it('no token → invalid without asking the server', async () => {
    const fetchMock = stub();
    const { wrapper } = await mountView(AcceptInviteView, { path: '/accept-invite' });
    expect(wrapper.text()).toContain('To zaproszenie jest nieważne');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signed in already → asks to sign out first', async () => {
    stub();
    const { wrapper } = await mountView(AcceptInviteView, { path: PATH, user: publicUser() });
    expect(wrapper.text()).toContain('Jesteś zalogowany jako jan@firma.pl');
    expect(wrapper.find('form').exists()).toBe(false);
  });
});
