import type { ProjectDetails, ProjectSummary } from '@app/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../test/fixtures';
import { useAuthStore } from './auth';
import { sortProjects, useProjectsStore } from './projects';

function summary(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: 'p0',
    name: 'Projekt',
    type: 'team',
    icon: null,
    description: null,
    role: 'project:admin',
    memberCount: 1,
    ...overrides,
  };
}

const personal = summary({
  id: 'p1',
  name: 'Jan Kowalski <jan@firma.pl>',
  type: 'personal',
  role: 'project:personalOwner',
});

function details(overrides: Partial<ProjectDetails>): ProjectDetails {
  return { ...summary(overrides), members: [], ...overrides };
}

describe('sortProjects', () => {
  it('personal first, then by name with Polish collation, then by id', () => {
    const sorted = sortProjects([
      summary({ id: 'b', name: 'Zebra' }),
      summary({ id: 'z', name: 'Łódź' }),
      summary({ id: 'a', name: 'Łódź' }),
      personal,
      summary({ id: 'c', name: 'Lublin' }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['p1', 'c', 'a', 'z', 'b']);
  });
});

describe('projects store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('create inserts the project where the server would list it and refreshes the user counts', async () => {
    const fetch = vi.fn(
      fakeServer({
        'GET /rest/projects/my-projects': {
          status: 200,
          body: [personal, summary({ id: 'p2', name: 'Lublin' }), summary({ id: 'p3', name: 'Zebra' })],
        },
        'POST /rest/projects': {
          status: 200,
          body: details({ id: 'p4', name: 'Łódź', icon: { type: 'emoji', value: '🚀' } }),
        },
        'GET /rest/login': { status: 200, body: publicUser({ ownedTeamProjects: 3 }) },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const auth = useAuthStore();
    auth.setUser(publicUser({ ownedTeamProjects: 2 }));
    const store = useProjectsStore();
    await store.load();

    const created = await store.create({ name: 'Łódź', icon: { type: 'emoji', value: '🚀' } });

    expect(created.id).toBe('p4');
    expect(store.myProjects.map((p) => p.name)).toEqual([
      'Jan Kowalski <jan@firma.pl>',
      'Lublin',
      'Łódź',
      'Zebra',
    ]);
    // The list holds summaries, not the members of the details answer.
    expect(store.myProjects[2]).not.toHaveProperty('members');
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(sentBody(post?.[1])).toEqual({ name: 'Łódź', icon: { type: 'emoji', value: '🚀' } });
    expect(auth.user?.ownedTeamProjects).toBe(3);
  });

  it('remove drops the project and refreshes the user counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/projects/my-projects': { status: 200, body: [personal, summary({ id: 'p2' })] },
          'DELETE /rest/projects/p2': { status: 200, body: { deleted: true } },
          'GET /rest/login': { status: 200, body: publicUser({ ownedTeamProjects: 0 }) },
        }),
      ),
    );
    const auth = useAuthStore();
    auth.setUser(publicUser({ ownedTeamProjects: 1 }));
    const store = useProjectsStore();
    await store.load();
    await store.remove('p2');
    expect(store.myProjects.map((p) => p.id)).toEqual(['p1']);
    expect(auth.user?.ownedTeamProjects).toBe(0);
  });

  it('update replaces the summary and keeps the order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/projects/my-projects': {
            status: 200,
            body: [personal, summary({ id: 'p2', name: 'Alfa' }), summary({ id: 'p3', name: 'Beta' })],
          },
          'PATCH /rest/projects/p2': { status: 200, body: details({ id: 'p2', name: 'Gamma' }) },
        }),
      ),
    );
    useAuthStore().setUser(publicUser({ ownedTeamProjects: 2 }));
    const store = useProjectsStore();
    await store.load();
    await store.update('p2', { name: 'Gamma' });
    expect(store.myProjects.map((p) => p.name)).toEqual(['Jan Kowalski <jan@firma.pl>', 'Beta', 'Gamma']);
  });

  it('leave removes the signed-in user from the project and from the list', async () => {
    const fetch = vi.fn(
      fakeServer({
        'GET /rest/projects/my-projects': {
          status: 200,
          body: [personal, summary({ id: 'p2', role: 'project:editor' })],
        },
        'DELETE /rest/projects/p2/members/u1': { status: 200, body: { removed: true } },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    useAuthStore().setUser(publicUser());
    const store = useProjectsStore();
    await store.load();
    await store.leave('p2');
    expect(store.myProjects.map((p) => p.id)).toEqual(['p1']);
    expect(fetch.mock.calls.some(([url]) => url === '/rest/projects/p2/members/u1')).toBe(true);
  });

  it('a project that is gone (404) is dropped from the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/projects/my-projects': { status: 200, body: [personal, summary({ id: 'p2' })] },
          'GET /rest/projects/p2': { status: 404, body: { message: 'Project not found' } },
        }),
      ),
    );
    useAuthStore().setUser(publicUser({ ownedTeamProjects: 1 }));
    const store = useProjectsStore();
    await store.load();
    await expect(store.get('p2')).rejects.toMatchObject({ status: 404 });
    expect(store.myProjects.map((p) => p.id)).toEqual(['p1']);
  });

  it('load re-reads the user when the owned count no longer matches (a transfer was accepted)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/projects/my-projects': {
            status: 200,
            body: [personal, summary({ id: 'p2', role: 'project:editor' })],
          },
          'GET /rest/login': { status: 200, body: publicUser({ ownedTeamProjects: 0 }) },
        }),
      ),
    );
    const auth = useAuthStore();
    auth.setUser(publicUser({ ownedTeamProjects: 1 }));
    await useProjectsStore().load();
    expect(auth.user?.ownedTeamProjects).toBe(0);
  });

  it('is emptied when another user signs in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/projects/my-projects': { status: 200, body: [personal] } })),
    );
    const auth = useAuthStore();
    auth.setUser(publicUser());
    const store = useProjectsStore();
    await store.load();
    auth.setUser(publicUser({ id: 'u2', email: 'ola@firma.pl' }));
    await Promise.resolve();
    expect(store.myProjects).toEqual([]);
    expect(store.loaded).toBe(false);
  });

  it('get() seeing the own role change to or from owner re-reads the user (owned counter)', async () => {
    let role: 'project:editor' | 'project:admin' = 'project:admin';
    const fetch = vi.fn(
      fakeServer({
        'GET /rest/projects/my-projects': { status: 200, body: [personal, summary({ id: 'p2' })] },
        'GET /rest/projects/p2': () => ({ status: 200, body: details({ id: 'p2', role }) }),
        'GET /rest/login': () => ({
          status: 200,
          body: publicUser({ ownedTeamProjects: role === 'project:admin' ? 1 : 0 }),
        }),
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const auth = useAuthStore();
    auth.setUser(publicUser({ ownedTeamProjects: 1 }));
    const store = useProjectsStore();
    await store.load();
    const logins = () => fetch.mock.calls.filter(([url]) => url === '/rest/login').length;

    await store.get('p2'); // same role: no re-read
    expect(logins()).toBe(0);

    role = 'project:editor'; // transferred away elsewhere
    await store.get('p2');
    await vi.waitFor(() => expect(auth.user?.ownedTeamProjects).toBe(0));
    expect(logins()).toBe(1);

    role = 'project:admin'; // and back
    await store.get('p2');
    await vi.waitFor(() => expect(auth.user?.ownedTeamProjects).toBe(1));
    expect(logins()).toBe(2);
  });

  it('a my-projects answer that arrives after another user signed in is ignored', async () => {
    let answer: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/rest/projects/my-projects')
          return new Promise<Response>((resolve) => (answer = resolve));
        return new Response('', { status: 404 });
      }),
    );
    const auth = useAuthStore();
    auth.setUser(publicUser());
    const store = useProjectsStore();
    const loading = store.load();
    auth.setUser(publicUser({ id: 'u2', email: 'ola@firma.pl' }));
    answer(new Response(JSON.stringify([personal, summary({ id: 'p2' })]), { status: 200 }));
    await loading;
    expect(store.myProjects).toEqual([]);
    expect(store.loaded).toBe(false);
  });

  it('any call answering 404 "Project not found" drops the project; other 404s do not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'GET /rest/projects/my-projects': {
            status: 200,
            body: [personal, summary({ id: 'p2' }), summary({ id: 'p3', role: 'project:editor' })],
          },
          'PATCH /rest/projects/p2': { status: 404, body: { message: 'Project not found' } },
          'DELETE /rest/projects/p3/members/u1': { status: 404, body: { message: 'Project not found' } },
          'DELETE /rest/projects/p2/invitations/i1': {
            status: 404,
            body: { message: 'Invitation not found' },
          },
        }),
      ),
    );
    useAuthStore().setUser(publicUser({ ownedTeamProjects: 1 }));
    const store = useProjectsStore();
    await store.load();
    await expect(store.cancelInvitation('p2', 'i1')).rejects.toMatchObject({ status: 404 });
    expect(store.myProjects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    await expect(store.update('p2', { name: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(store.leave('p3')).rejects.toMatchObject({ status: 404 });
    expect(store.myProjects.map((p) => p.id)).toEqual(['p1']);
  });
});
