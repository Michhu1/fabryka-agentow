import type { PublicUser } from '@app/shared';

export function publicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: 'u1',
    email: 'jan@firma.pl',
    firstName: 'Jan',
    lastName: 'Kowalski',
    role: 'global:member',
    mfaEnabled: false,
    settings: { theme: 'system' },
    personalProjectId: 'p1',
    teamProjectsLimit: 3,
    ownedTeamProjects: 0,
    ...overrides,
  };
}

type Route = { status: number; body?: unknown };
type Handler = Route | ((init: RequestInit | undefined, url: string) => Route);

/**
 * A `fetch` stub answering by "METHOD /path" (query string ignored); unknown routes → 404. Returns the
 * mock, so tests can inspect calls.
 */
export function fakeServer(routes: Record<string, Handler>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = input.split('?')[0] ?? input;
    const handler = routes[`${method} ${path}`];
    const route = typeof handler === 'function' ? handler(init, input) : handler;
    const { status, body } = route ?? { status: 404, body: { message: 'Not found' } };
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
}

/** Parsed JSON body of a recorded `fetch` call. */
export function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : {};
}
