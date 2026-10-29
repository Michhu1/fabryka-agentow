import type { GlobalRole, InstanceUser, UserList } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import UsersSettingsView from './UsersSettingsView.vue';

function account(
  id: string,
  firstName: string,
  role: GlobalRole,
  extra: Partial<InstanceUser> = {},
): InstanceUser {
  return {
    id,
    email: `${firstName.toLowerCase()}@firma.pl`,
    firstName,
    lastName: 'Nowak',
    role,
    disabled: false,
    mfaEnabled: false,
    lastActiveAt: '2026-10-28',
    isPending: false,
    ...extra,
  };
}

/** u0 owns the platform, u1 is the signed-in user (Jan), u2 an admin, u3 a member, u4 invited. */
const USERS: UserList = {
  count: 5,
  items: [
    account('u0', 'Olga', 'global:owner', { mfaEnabled: true }),
    account('u1', 'Jan', 'global:admin'),
    account('u2', 'Adam', 'global:admin'),
    account('u3', 'Ewa', 'global:member'),
    account('u4', '', 'global:member', {
      email: 'nowy@firma.pl',
      lastName: '',
      isPending: true,
      lastActiveAt: null,
    }),
  ],
};

type Routes = Parameters<typeof fakeServer>[0];

function stub(extra: Routes = {}) {
  const fetch = vi.fn(fakeServer({ 'GET /rest/users': { status: 200, body: USERS }, ...extra }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function mountUsers(role: GlobalRole) {
  return mountView(UsersSettingsView, {
    path: '/settings/users',
    user: publicUser({ id: 'u1', role }),
    attach: true,
  });
}

const row = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-test="user-row"][data-id="${id}"]`);
const inBody = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('element not found');
  (element as HTMLElement).click();
  await flushPromises();
}

describe('UsersSettingsView', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('lists accounts with role, status, 2FA and last activity', async () => {
    stub();
    await mountUsers('global:admin');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Olga Nowak');
    expect(row('u0')?.textContent).toContain('Właściciel platformy');
    expect(row('u2')?.textContent).toContain('Administrator');
    expect(row('u3')?.textContent).toContain('Użytkownik');
    expect(row('u3')?.textContent).toContain('Aktywny');
    expect(row('u4')?.textContent).toContain('Zaproszony');
    expect(row('u4')?.textContent).toContain('Nigdy');
    expect(row('u0')?.textContent).toContain('Włączona');
  });

  it('global:admin: no role change anywhere; actions only on members (not self, owner or admins)', async () => {
    stub();
    await mountUsers('global:admin');
    expect(document.body.querySelectorAll('[data-test="user-role"]')).toHaveLength(0);
    for (const id of ['u0', 'u1', 'u2']) {
      expect(row(id)?.querySelector('[data-test="user-disable"]'), id).toBeNull();
      expect(row(id)?.querySelector('[data-test="user-delete"]'), id).toBeNull();
    }
    expect(row('u3')?.querySelector('[data-test="user-disable"]')).not.toBeNull();
    expect(row('u3')?.querySelector('[data-test="user-delete"]')).not.toBeNull();
  });

  it('global:owner: changes roles of others (not own, not the owner)', async () => {
    const fetch = stub({
      'PATCH /rest/users/u3/role': { status: 200, body: account('u3', 'Ewa', 'global:admin') },
    });
    await mountUsers('global:owner');
    // The signed-in owner here is u1 (Jan); Olga's row stands for "the owner" in the list.
    expect(row('u0')?.querySelector('[data-test="user-role"]')).toBeNull();
    expect(row('u1')?.querySelector('[data-test="user-role"]')).toBeNull();
    expect(row('u2')?.querySelector('[data-test="user-role"]')).not.toBeNull();
    const select = row('u3')?.querySelector<HTMLSelectElement>('[data-test="user-role"] select');
    if (!select) throw new Error('no role select');
    select.value = 'global:admin';
    select.dispatchEvent(new Event('change'));
    await flushPromises();
    const call = fetch.mock.calls.find(
      ([url, init]) => url === '/rest/users/u3/role' && init?.method === 'PATCH',
    );
    expect(sentBody(call?.[1])).toEqual({ role: 'global:admin' });
    expect(row('u3')?.querySelector<HTMLSelectElement>('[data-test="user-role"] select')?.value).toBe(
      'global:admin',
    );
  });

  it('disabling warns that the projects get hidden, then disables', async () => {
    const fetch = stub({
      'PATCH /rest/users/u3': {
        status: 200,
        body: account('u3', 'Ewa', 'global:member', { disabled: true }),
      },
    });
    await mountUsers('global:admin');
    await click(row('u3')?.querySelector('[data-test="user-disable"]'));
    expect(inBody('[role="dialog"]')?.textContent).toContain(
      'projekty tej osoby zostaną ukryte dla wszystkich członków',
    );
    await click(inBody('[data-test="user-action-confirm"]'));
    const call = fetch.mock.calls.find(([url, init]) => url === '/rest/users/u3' && init?.method === 'PATCH');
    expect(sentBody(call?.[1])).toEqual({ disabled: true });
    expect(row('u3')?.textContent).toContain('Zablokowany');
    expect(row('u3')?.querySelector('[data-test="user-enable"]')).not.toBeNull();
  });

  it('deleting an owner of team projects (409) shows how many — never which — and offers blocking', async () => {
    stub({
      'DELETE /rest/users/u3': {
        status: 409,
        body: { message: 'User owns team projects', projectCount: 3 },
      },
    });
    await mountUsers('global:admin');
    await click(row('u3')?.querySelector('[data-test="user-delete"]'));
    await click(inBody('[data-test="user-action-confirm"]'));
    const dialog = inBody('[role="dialog"]')?.textContent ?? '';
    expect(dialog).toContain('właścicielem 3 projektów zespołowych');
    expect(dialog).toContain('zablokować');
    expect(row('u3')).not.toBeNull();
    await click(inBody('[data-test="user-block-instead"]'));
    expect(inBody('[role="dialog"]')?.textContent).toContain('projekty tej osoby zostaną ukryte');
  });

  it('a single owned project reads in the singular', async () => {
    stub({
      'DELETE /rest/users/u3': { status: 409, body: { message: 'User owns team projects', projectCount: 1 } },
    });
    await mountUsers('global:admin');
    await click(row('u3')?.querySelector('[data-test="user-delete"]'));
    await click(inBody('[data-test="user-action-confirm"]'));
    expect(inBody('[role="dialog"]')?.textContent).toContain('właścicielem 1 projektu zespołowego');
  });

  it('a 409 without the count → a general message, never "0 projektów"', async () => {
    stub({ 'DELETE /rest/users/u3': { status: 409, body: { message: 'User owns team projects' } } });
    await mountUsers('global:admin');
    await click(row('u3')?.querySelector('[data-test="user-delete"]'));
    await click(inBody('[data-test="user-action-confirm"]'));
    const dialog = inBody('[role="dialog"]')?.textContent ?? '';
    expect(dialog).toContain(
      'Nie można usunąć tego konta: ta osoba jest właścicielem projektów zespołowych.',
    );
    expect(dialog).not.toMatch(/\b0 projekt/);
    expect(inBody('[data-test="user-block-instead"]')).not.toBeNull();
  });

  it('the users table has an accessible name', async () => {
    stub();
    await mountUsers('global:admin');
    const table = inBody('table');
    const caption = table?.querySelector('caption');
    expect(caption?.textContent?.trim()).toBe('Użytkownicy platformy');
    expect(caption?.classList.contains('visually-hidden')).toBe(true);
  });

  it('search waits for the typing to stop, then asks the server from the first page', async () => {
    const fetch = stub();
    await mountUsers('global:admin');
    vi.useFakeTimers();
    const input = inBody<HTMLInputElement>('[data-test="users-search"] input');
    if (!input) throw new Error('no search');
    for (const value of ['e', 'ew', 'ewa']) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    await vi.advanceTimersByTimeAsync(100);
    const searches = () => fetch.mock.calls.filter(([url]) => String(url).includes('search='));
    expect(searches()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(searches()).toHaveLength(1);
    expect(String(searches()[0]?.[0])).toContain('search=ewa');
    expect(String(searches()[0]?.[0])).toContain('skip=0');
  });

  it('invite: several addresses; the admin role is offered only to the platform owner', async () => {
    const fetch = stub({
      'POST /rest/invitations': {
        status: 200,
        body: [
          { email: 'a@firma.pl', status: 'invited' },
          { email: 'ewa@firma.pl', status: 'exists' },
        ],
      },
    });
    await mountUsers('global:admin');
    await click(inBody('[data-test="users-invite"]'));
    const options = [...document.body.querySelectorAll('[data-test="invite-role"] option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['global:member']);
    const textarea = inBody<HTMLTextAreaElement>('[data-test="invite-emails"] textarea');
    if (!textarea) throw new Error('no textarea');
    textarea.value = 'a@firma.pl, Ewa@firma.pl\na@firma.pl';
    textarea.dispatchEvent(new Event('input'));
    await click(inBody('[data-test="invite-submit"]'));
    const call = fetch.mock.calls.find(([url]) => url === '/rest/invitations');
    expect(sentBody(call?.[1])).toEqual({ emails: ['a@firma.pl', 'ewa@firma.pl'], role: 'global:member' });
    const results = inBody('[data-test="invite-results"]')?.textContent ?? '';
    expect(results).toContain('Zaproszenie wysłane');
    expect(results).toContain('Konto z tym adresem już istnieje');
  });

  it('the platform owner can invite administrators', async () => {
    stub();
    await mountUsers('global:owner');
    await click(inBody('[data-test="users-invite"]'));
    const options = [...document.body.querySelectorAll('[data-test="invite-role"] option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['global:member', 'global:admin']);
  });
});
