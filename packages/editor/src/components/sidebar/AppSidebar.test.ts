import type { ProjectSummary } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import AppSidebar from './AppSidebar.vue';

const projects: ProjectSummary[] = [
  {
    id: 'p1',
    name: 'Jan Kowalski <jan@firma.pl>',
    type: 'personal',
    icon: null,
    description: null,
    role: 'project:personalOwner',
    memberCount: 1,
  },
  {
    id: 'p2',
    name: 'Biuro',
    type: 'team',
    icon: { type: 'emoji', value: '🏢' },
    description: null,
    role: 'project:admin',
    memberCount: 2,
  },
  {
    id: 'p3',
    name: 'Sklep',
    type: 'team',
    icon: null,
    description: null,
    role: 'project:editor',
    memberCount: 3,
  },
];

function stubServer(readinessStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      fakeServer({
        'GET /rest/projects/my-projects': { status: 200, body: projects },
        'GET /rest/version': { status: 200, body: { name: 'moj-n8n', version: '0.0.0' } },
        'GET /healthz/readiness': { status: readinessStatus, body: {} },
        'POST /rest/logout': { status: 200, body: { loggedOut: true } },
      }),
    ),
  );
}

describe('AppSidebar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('links Overview, Personal and the team projects', async () => {
    stubServer();
    const { wrapper } = await mountView(AppSidebar, {
      path: '/home',
      user: publicUser({ ownedTeamProjects: 1 }),
    });
    const links = wrapper.findAll('a').map((a) => [a.text(), a.attributes('href')]);
    expect(links).toEqual(
      expect.arrayContaining([
        ['Przegląd', '/home'],
        ['Osobiste', '/projects/p1'],
        [expect.stringContaining('Biuro'), '/projects/p2'],
        [expect.stringContaining('Sklep'), '/projects/p3'],
      ]),
    );
  });

  it('keeps the project highlighted on its settings page', async () => {
    stubServer();
    const { wrapper } = await mountView(AppSidebar, { path: '/projects/p2/settings', user: publicUser() });
    const current = wrapper.findAll('a').filter((a) => a.classes('sidebar__link--current'));
    expect(current.map((a) => a.attributes('href'))).toEqual(['/projects/p2']);
  });

  it('shows "Projekty: 2 z 3" from the user and lets them create one more', async () => {
    stubServer();
    const { wrapper } = await mountView(AppSidebar, {
      path: '/home',
      user: publicUser({ ownedTeamProjects: 2, teamProjectsLimit: 3 }),
    });
    expect(wrapper.get('[data-test="projects-counter"]').text()).toBe('Projekty: 2 z 3');
    const create = wrapper.get('[data-test="new-project"]');
    expect(create.attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain('Osiągnięto limit projektów');
  });

  it('at the limit "Nowy projekt" is disabled and says why', async () => {
    stubServer();
    const { wrapper } = await mountView(AppSidebar, {
      path: '/home',
      user: publicUser({ ownedTeamProjects: 3, teamProjectsLimit: 3 }),
    });
    expect(wrapper.get('[data-test="projects-counter"]').text()).toBe('Projekty: 3 z 3');
    const create = wrapper.get('[data-test="new-project"]');
    expect(create.attributes('disabled')).toBeDefined();
    const reason = wrapper.get('[data-test="projects-limit"]');
    expect(reason.text()).toContain('Osiągnięto limit projektów');
    expect(create.attributes('aria-describedby')).toBe(reason.attributes('id'));
  });

  it('shows the server version and state in the footer', async () => {
    stubServer(503);
    const { wrapper } = await mountView(AppSidebar, { path: '/home', user: publicUser() });
    expect(wrapper.text()).toContain('moj-n8n 0.0.0');
    expect(wrapper.text()).toContain('Serwer: niedostępny');
  });

  it('the account menu offers settings and signs out', async () => {
    stubServer();
    const { wrapper, auth } = await mountView(AppSidebar, {
      path: '/home',
      user: publicUser(),
      attach: true,
    });
    const trigger = wrapper.get('[data-test="user-menu"]');
    expect(trigger.text()).toContain('Jan Kowalski');
    // reka-ui opens the menu on pointerdown (mouse) or Enter/Space (keyboard).
    await trigger.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const settings = document.body.querySelector<HTMLAnchorElement>('[data-test="menu-settings"]');
    expect(settings?.getAttribute('href')).toBe('/settings/personal');
    const logout = document.body.querySelector<HTMLElement>('[data-test="menu-logout"]');
    expect(logout?.textContent).toContain('Wyloguj się');
    logout?.click();
    await flushPromises();
    expect(auth.user).toBeNull();
  });
});
