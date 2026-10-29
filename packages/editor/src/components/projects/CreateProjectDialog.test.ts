import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import CreateProjectDialog from './CreateProjectDialog.vue';

const inBody = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

function typeName(value: string) {
  const input = inBody<HTMLInputElement>('[data-test="project-name"] input');
  if (!input) throw new Error('name field missing');
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function submit() {
  inBody<HTMLFormElement>('[role="dialog"] form')?.requestSubmit();
  return flushPromises();
}

function mountDialog(user = publicUser()) {
  return mountView(CreateProjectDialog, { path: '/home', user, props: { open: true }, attach: true });
}

describe('CreateProjectDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('creates the project, refreshes the counter and opens the new project', async () => {
    const fetchMock = vi.fn(
      fakeServer({
        'POST /rest/projects': {
          status: 200,
          body: {
            id: 'p9',
            name: 'Sklep',
            type: 'team',
            icon: null,
            description: null,
            role: 'project:admin',
            memberCount: 1,
            members: [],
          },
        },
        'GET /rest/login': { status: 200, body: publicUser({ ownedTeamProjects: 1 }) },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { router, auth, wrapper } = await mountDialog();
    typeName('  Sklep ');
    await submit();
    const call = fetchMock.mock.calls.find(
      ([url, init]) => url === '/rest/projects' && init?.method === 'POST',
    );
    expect(sentBody(call?.[1])).toEqual({ name: 'Sklep', icon: null });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/projects/p9'));
    expect(auth.user?.ownedTeamProjects).toBe(1);
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('an empty name is caught before sending', async () => {
    const fetchMock = vi.fn(fakeServer({}));
    vi.stubGlobal('fetch', fetchMock);
    await mountDialog();
    typeName('   ');
    await submit();
    expect(inBody('[role="dialog"]')?.textContent).toContain('Podaj nazwę.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 "Team project limit reached" → the limit explained; the dialog stays open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'POST /rest/projects': { status: 403, body: { message: 'Team project limit reached' } },
          'GET /rest/login': {
            status: 200,
            body: publicUser({ teamProjectsLimit: 3, ownedTeamProjects: 3 }),
          },
        }),
      ),
    );
    const { router } = await mountDialog(publicUser({ teamProjectsLimit: 3 }));
    typeName('Czwarty');
    await submit();
    expect(inBody('[role="dialog"]')?.textContent).toContain('Masz już 3 z 3 projektów zespołowych');
    expect(router.currentRoute.value.path).toBe('/home');
  });
});
