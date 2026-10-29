import type { ProjectInvitationInfo, ProjectTransferInfo } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import ProjectLinkView from './ProjectLinkView.vue';

const TOKEN = 'A'.repeat(43);

function invitation(overrides: Partial<ProjectInvitationInfo> = {}): ProjectInvitationInfo {
  return {
    email: 'nowy@firma.pl',
    projectName: 'Biuro',
    inviterName: 'Olga Owczarek',
    role: 'project:editor',
    hasAccount: true,
    pendingInvite: false,
    ...overrides,
  };
}

function mountInvite(user: ReturnType<typeof publicUser> | null = null) {
  return mountView(ProjectLinkView, {
    path: `/project-invitation?token=${TOKEN}`,
    user,
    props: { kind: 'invitation' },
  });
}

describe('ProjectLinkView — invitation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signed out, account exists → "Zaloguj się" with the email and a way back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/project-invitations/resolve': { status: 200, body: invitation() } })),
    );
    const { wrapper, router } = await mountInvite();
    expect(wrapper.text()).toContain('Olga Owczarek zaprasza Cię do projektu „Biuro”.');
    expect(wrapper.text()).toContain('Twoja rola: Edytor');
    const link = wrapper.get('[data-test="account-link"]');
    expect(link.text()).toBe('Zaloguj się');
    const target = router.resolve(link.attributes('href') ?? '');
    expect(target.name).toBe('signin');
    expect(target.query).toEqual({ email: 'nowy@firma.pl', redirect: `/project-invitation?token=${TOKEN}` });
  });

  it('signed out, no account → "Załóż konto" carrying the invite token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': { status: 200, body: invitation({ hasAccount: false }) },
        }),
      ),
    );
    const { wrapper, router } = await mountInvite();
    const link = wrapper.get('[data-test="account-link"]');
    expect(link.text()).toBe('Załóż konto');
    const target = router.resolve(link.attributes('href') ?? '');
    expect(target.name).toBe('signup');
    expect(target.query).toMatchObject({ email: 'nowy@firma.pl', inviteToken: TOKEN });
  });

  it('signed in as another address → explains and offers to sign out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': { status: 200, body: invitation() },
          'POST /rest/logout': { status: 200, body: { loggedOut: true } },
        }),
      ),
    );
    const { wrapper, auth } = await mountInvite(publicUser({ email: 'jan@firma.pl' }));
    expect(wrapper.text()).toContain('Jesteś zalogowany jako jan@firma.pl');
    expect(wrapper.text()).not.toContain('Akceptuj');
    const logout = wrapper.findAll('button').find((b) => b.text() === 'Wyloguj się');
    await logout?.trigger('click');
    await flushPromises();
    expect(auth.user).toBeNull();
    expect(wrapper.get('[data-test="account-link"]').text()).toBe('Zaloguj się');
  });

  it('signed in as the invited address → "Akceptuj" accepts and opens the project', async () => {
    const fetchMock = vi.fn(
      fakeServer({
        'GET /rest/project-invitations/resolve': { status: 200, body: invitation() },
        'POST /rest/project-invitations/accept': { status: 200, body: { id: 'proj-1', name: 'Biuro' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper, router } = await mountInvite(publicUser({ email: 'nowy@firma.pl' }));
    const accept = wrapper.findAll('button').find((b) => b.text() === 'Akceptuj');
    await accept?.trigger('click');
    await flushPromises();
    const call = fetchMock.mock.calls.find(([url]) => url === '/rest/project-invitations/accept');
    expect(sentBody(call?.[1])).toEqual({ token: TOKEN });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/projects/proj-1'));
    expect(router.currentRoute.value.name).toBe('project');
  });

  it('signed out, address invited to the platform but not accepted → "accept that first", no buttons', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': {
            status: 200,
            body: invitation({ hasAccount: false, pendingInvite: true }),
          },
        }),
      ),
    );
    const { wrapper } = await mountInvite();
    expect(wrapper.text()).toContain(
      'Najpierw przyjmij zaproszenie na platformę — sprawdź skrzynkę (mail z zaproszeniem).',
    );
    expect(wrapper.find('[data-test="account-link"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Załóż konto');
  });

  it('409 already a member → no "Akceptuj", "Przejdź do projektu" opens it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': { status: 200, body: invitation() },
          'POST /rest/project-invitations/accept': {
            status: 409,
            body: { message: 'User is already a member', projectId: 'proj-1' },
          },
        }),
      ),
    );
    const { wrapper, router } = await mountInvite(publicUser({ email: 'nowy@firma.pl' }));
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Akceptuj')
      ?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Jesteś już członkiem tego projektu.');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Akceptuj')).toBe(false);
    const open = wrapper.get('[data-test="open-project"]');
    expect(open.text()).toBe('Przejdź do projektu');
    expect(router.resolve(open.attributes('href') ?? '').path).toBe('/projects/proj-1');
  });

  it('409 already a member without a project id → "Przejdź do projektu" goes home', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': { status: 200, body: invitation() },
          'POST /rest/project-invitations/accept': {
            status: 409,
            body: { message: 'User is already a member' },
          },
        }),
      ),
    );
    const { wrapper, router } = await mountInvite(publicUser({ email: 'nowy@firma.pl' }));
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Akceptuj')
      ?.trigger('click');
    await flushPromises();
    const open = wrapper.get('[data-test="open-project"]');
    expect(router.resolve(open.attributes('href') ?? '').path).toBe('/home');
  });

  it('an invalid link while signed out offers signing in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': {
            status: 400,
            body: { message: 'Invalid invitation token' },
          },
        }),
      ),
    );
    const { wrapper, router } = await mountInvite();
    const link = wrapper.get('[data-test="signin-link"]');
    expect(router.resolve(link.attributes('href') ?? '').name).toBe('signin');
  });

  it('an expired or used link → a clear message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-invitations/resolve': {
            status: 400,
            body: { message: 'Invalid invitation token' },
          },
        }),
      ),
    );
    const { wrapper } = await mountInvite();
    expect(wrapper.text()).toContain('To zaproszenie jest nieważne, wygasło albo zostało już wykorzystane.');
  });
});

describe('ProjectLinkView — transfer', () => {
  afterEach(() => vi.unstubAllGlobals());

  const transfer: ProjectTransferInfo = {
    email: 'nowy@firma.pl',
    projectName: 'Biuro',
    fromName: 'Olga Owczarek',
    hasAccount: true,
    pendingInvite: false,
  };

  it('limit reached → explains the limit; the page stays', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/project-transfers/resolve': { status: 200, body: transfer },
          'POST /rest/project-transfers/accept': {
            status: 403,
            body: { message: 'Team project limit reached' },
          },
        }),
      ),
    );
    const { wrapper } = await mountView(ProjectLinkView, {
      path: `/project-transfer?token=${TOKEN}`,
      user: publicUser({ email: 'nowy@firma.pl', teamProjectsLimit: 3, ownedTeamProjects: 3 }),
      props: { kind: 'transfer' },
    });
    expect(wrapper.text()).toContain('Olga Owczarek chce przekazać Ci projekt „Biuro”.');
    const accept = wrapper.findAll('button').find((b) => b.text() === 'Akceptuj');
    await accept?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Masz już maksymalną liczbę projektów zespołowych (3).');
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
