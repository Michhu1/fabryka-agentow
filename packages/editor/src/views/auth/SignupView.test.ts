import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import SignupView from './SignupView.vue';

const TOKEN = 'A'.repeat(43);
const FROM_LINK = `/signup?email=nowy%40firma.pl&inviteToken=${TOKEN}&redirect=%2Fproject-invitation%3Ftoken%3D${TOKEN}`;

function stub() {
  const fetchMock = vi.fn(
    fakeServer({ 'POST /rest/signup': { status: 200, body: publicUser({ email: 'nowy@firma.pl' }) } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type Wrapper = Awaited<ReturnType<typeof mountView>>['wrapper'];

async function fill(wrapper: Wrapper, password: string) {
  await wrapper.get('input[name="firstName"]').setValue('Nowy');
  await wrapper.get('input[name="lastName"]').setValue('Gość');
  await wrapper.get('input[type="password"]').setValue(password);
}

const signupCalls = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([url]) => url === '/rest/signup');

describe('SignupView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('from a project link: the email is locked, the invite token is sent, then back to the link', async () => {
    const fetchMock = stub();
    const { wrapper, router } = await mountView(SignupView, { path: FROM_LINK });
    const email = wrapper.get('input[type="email"]');
    expect((email.element as HTMLInputElement).value).toBe('nowy@firma.pl');
    expect(email.attributes('readonly')).toBeDefined();
    expect(wrapper.text()).toContain('Konto zostanie założone na adres z zaproszenia.');

    await fill(wrapper, 'Haslo123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(sentBody(signupCalls(fetchMock)[0]?.[1])).toEqual({
      email: 'nowy@firma.pl',
      firstName: 'Nowy',
      lastName: 'Gość',
      password: 'Haslo123',
      inviteToken: TOKEN,
    });
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-invitation'));
  });

  it('?email= without a token only prefills (editable); no inviteToken is sent', async () => {
    const fetchMock = stub();
    const { wrapper } = await mountView(SignupView, { path: '/signup?email=ola%40firma.pl' });
    const email = wrapper.get('input[type="email"]');
    expect((email.element as HTMLInputElement).value).toBe('ola@firma.pl');
    expect(email.attributes('readonly')).toBeUndefined();
    await email.setValue('inna@firma.pl');
    await fill(wrapper, 'Haslo123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const body = sentBody(signupCalls(fetchMock)[0]?.[1]);
    expect(body.email).toBe('inna@firma.pl');
    expect(body).not.toHaveProperty('inviteToken');
  });

  it('a password against the policy is caught before anything is sent', async () => {
    const fetchMock = stub();
    const { wrapper } = await mountView(SignupView, { path: '/signup' });
    await wrapper.get('input[type="email"]').setValue('nowy@firma.pl');
    await fill(wrapper, 'haslo123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Hasło musi mieć 8–64 znaki');
    expect(signupCalls(fetchMock)).toHaveLength(0);
  });

  it('server errors are shown in Polish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'POST /rest/signup': { status: 403, body: { message: 'Signup is disabled' } } })),
    );
    const { wrapper } = await mountView(SignupView, { path: '/signup' });
    await wrapper.get('input[type="email"]').setValue('nowy@firma.pl');
    await fill(wrapper, 'Haslo123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Rejestracja jest wyłączona.');
  });

  it('the sign-in link keeps the link context', async () => {
    stub();
    const { wrapper, router } = await mountView(SignupView, { path: FROM_LINK });
    const signin = wrapper.findAll('a').find((a) => a.text() === 'Zaloguj się');
    expect(router.resolve(signin?.attributes('href') ?? '').query).toEqual({
      email: 'nowy@firma.pl',
      inviteToken: TOKEN,
      redirect: `/project-invitation?token=${TOKEN}`,
    });
  });
});
