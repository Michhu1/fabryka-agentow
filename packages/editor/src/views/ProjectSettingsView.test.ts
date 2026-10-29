import type { ProjectDetails, ProjectInvitation, ProjectMember, ProjectRole } from '@app/shared';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../test/fixtures';
import { mountView } from '../test/mount';
import ProjectSettingsView from './ProjectSettingsView.vue';

const PATH = '/projects/p2/settings';

function member(userId: string, firstName: string, role: ProjectRole): ProjectMember {
  return { userId, email: `${firstName.toLowerCase()}@firma.pl`, firstName, lastName: 'Nowak', role };
}

/** Jan (u1, the signed-in user) has `role`; Olga owns the project unless Jan does. */
function project(role: ProjectRole): ProjectDetails {
  const jan = member('u1', 'Jan', role);
  const members =
    role === 'project:admin'
      ? [jan, member('u2', 'Ola', 'project:editor'), member('u3', 'Piotr', 'project:viewer')]
      : [member('u0', 'Olga', 'project:admin'), jan, member('u3', 'Piotr', 'project:viewer')];
  return {
    id: 'p2',
    name: 'Biuro',
    type: 'team',
    icon: { type: 'emoji', value: '🏢' },
    description: 'Sprawy biura',
    role,
    memberCount: members.length,
    members,
  };
}

const invitation: ProjectInvitation = {
  id: 'i1',
  email: 'nowa@firma.pl',
  role: 'project:viewer',
  expiresAt: '2026-11-05T10:00:00.000Z',
  createdAt: '2026-10-29T10:00:00.000Z',
};

type Routes = Parameters<typeof fakeServer>[0];

function stub(role: ProjectRole, extra: Routes = {}) {
  const fetch = vi.fn(
    fakeServer({
      'GET /rest/projects/p2': { status: 200, body: project(role) },
      'GET /rest/projects/p2/invitations': { status: 200, body: [invitation] },
      'GET /rest/projects/p2/transfer': { status: 200, body: null },
      'GET /rest/projects/my-projects': { status: 200, body: [] },
      'GET /rest/login': { status: 200, body: publicUser() },
      ...extra,
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function mountSettings(user = publicUser()) {
  return mountView(ProjectSettingsView, { path: PATH, user, attach: true });
}

function requested(fetch: ReturnType<typeof stub>, method: string, url: string) {
  return fetch.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method);
}

const body = () => document.body;
const inBody = <T extends Element = HTMLElement>(selector: string) => body().querySelector<T>(selector);

async function typeInto(wrapper: VueWrapper, selector: string, value: string) {
  await wrapper.get(selector).setValue(value);
}

/** Types into a field of a dialog (teleported to <body>). */
function typeInBody(selector: string, value: string) {
  const input = inBody<HTMLInputElement>(selector);
  if (!input) throw new Error(`${selector} missing`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

const GONE = { status: 404, body: { message: 'Project not found' } };

describe('ProjectSettingsView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  describe('as project:viewer', () => {
    it('fields are disabled, no save, no invitations, no transfer, no danger zone', async () => {
      const fetch = stub('project:viewer');
      const { wrapper } = await mountSettings();
      expect(wrapper.text()).toContain('Tylko właściciel projektu może zmieniać jego ustawienia.');
      expect((wrapper.get('[data-test="project-name"] input').element as HTMLInputElement).disabled).toBe(
        true,
      );
      expect(
        (wrapper.get('[data-test="project-description"] textarea').element as HTMLTextAreaElement).disabled,
      ).toBe(true);
      expect(wrapper.get('[data-test="icon-picker"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-test="save"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Strefa niebezpieczna');
      expect(wrapper.find('[data-test="invite-section"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="transfer-section"]').exists()).toBe(false);
      // Members are listed, without controls.
      expect(wrapper.findAll('[data-test="member-row"]')).toHaveLength(3);
      expect(wrapper.find('[data-test="member-role"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="member-remove"]').exists()).toBe(false);
      // Owner-only data is never requested.
      expect(requested(fetch, 'GET', '/rest/projects/p2/invitations')).toHaveLength(0);
      expect(requested(fetch, 'GET', '/rest/projects/p2/transfer')).toHaveLength(0);
      expect(wrapper.find('[data-test="leave-section"]').exists()).toBe(true);
    });
  });

  describe('as project:editor', () => {
    it('sees no invitations and no transfer section', async () => {
      stub('project:editor');
      const { wrapper } = await mountSettings();
      expect(wrapper.find('[data-test="invite-section"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="transfer-section"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Zaproś do projektu');
      expect(wrapper.text()).not.toContain('Przekaż projekt');
      expect(wrapper.text()).not.toContain('Strefa niebezpieczna');
      expect(wrapper.find('[data-test="leave-section"]').exists()).toBe(true);
    });

    it('a 409 from the server is shown in Polish (the owner cannot leave)', async () => {
      stub('project:editor', {
        'DELETE /rest/projects/p2/members/u1': {
          status: 409,
          body: { message: 'The project owner cannot leave the project; transfer it first' },
        },
      });
      const { wrapper } = await mountSettings();
      await wrapper.get('[data-test="leave"]').trigger('click');
      await flushPromises();
      inBody('[data-test="leave-confirm"]')?.click();
      await flushPromises();
      expect(body().textContent).toContain(
        'Właściciel nie może opuścić projektu. Najpierw przekaż go komuś innemu.',
      );
    });

    it('leaving a project that is gone meanwhile → "not found", and it leaves the sidebar', async () => {
      stub('project:editor', {
        'GET /rest/projects/my-projects': { status: 200, body: [project('project:editor')] },
        'DELETE /rest/projects/p2/members/u1': GONE,
      });
      const { wrapper } = await mountSettings();
      const { useProjectsStore } = await import('../stores/projects');
      const store = useProjectsStore();
      await store.load();
      expect(store.myProjects.map((p) => p.id)).toEqual(['p2']);
      await wrapper.get('[data-test="leave"]').trigger('click');
      await flushPromises();
      inBody('[data-test="leave-confirm"]')?.click();
      await flushPromises();
      expect(wrapper.text()).toContain('Projekt nie istnieje albo nie masz do niego dostępu.');
      expect(store.myProjects).toEqual([]);
      expect(inBody('[role="dialog"]')).toBeNull();
    });

    it('leaving goes back to the overview', async () => {
      const fetch = stub('project:editor', {
        'DELETE /rest/projects/p2/members/u1': { status: 200, body: { removed: true } },
      });
      const { wrapper, router } = await mountSettings();
      await wrapper.get('[data-test="leave"]').trigger('click');
      await flushPromises();
      inBody('[data-test="leave-confirm"]')?.click();
      await flushPromises();
      expect(requested(fetch, 'DELETE', '/rest/projects/p2/members/u1')).toHaveLength(1);
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'));
    });
  });

  describe('as the owner (project:admin)', () => {
    it('the owner row has no role change or remove; other members do', async () => {
      stub('project:admin');
      const { wrapper } = await mountSettings();
      const rows = wrapper.findAll('[data-test="member-row"]');
      expect(rows).toHaveLength(3);
      const owner = rows[0];
      expect(owner?.text()).toContain('Jan Nowak');
      expect(owner?.text()).toContain('Właściciel');
      expect(owner?.find('[data-test="member-role"]').exists()).toBe(false);
      expect(owner?.find('[data-test="member-remove"]').exists()).toBe(false);
      for (const row of rows.slice(1)) {
        expect(row.find('[data-test="member-role"]').exists()).toBe(true);
        expect(row.find('[data-test="member-remove"]').exists()).toBe(true);
      }
      // Only Editor and Viewer can be given.
      const options = rows[1]?.findAll('[data-test="member-role"] option').map((o) => o.text());
      expect(options).toEqual(['Edytor', 'Podgląd']);
      expect(wrapper.find('[data-test="leave-section"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Strefa niebezpieczna');
    });

    it('a 403 after the project was transferred elsewhere re-reads it and says the role changed', async () => {
      let transferred = false;
      stub('project:admin', {
        'GET /rest/projects/p2': () => ({
          status: 200,
          body: transferred ? project('project:editor') : project('project:admin'),
        }),
        'PATCH /rest/projects/p2/members/u2': () => {
          transferred = true;
          return { status: 403, body: { message: 'Forbidden' } };
        },
      });
      const { wrapper } = await mountSettings();
      expect(wrapper.find('[data-test="invite-section"]').exists()).toBe(true);
      await wrapper.findAll('[data-test="member-role"] select')[0]?.setValue('project:viewer');
      await flushPromises();
      expect(wrapper.get('[data-test="role-changed"]').text()).toContain(
        'Twoja rola w tym projekcie się zmieniła',
      );
      expect(wrapper.find('[data-test="invite-section"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="member-role"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Twoja rola: Edytor');
    });

    it('removing a member asks first, then shows the project without them', async () => {
      const after = project('project:admin');
      after.members = after.members.filter((m) => m.userId !== 'u2');
      after.memberCount = after.members.length;
      let removed = false;
      const fetch = stub('project:admin', {
        'GET /rest/projects/p2': () => ({ status: 200, body: removed ? after : project('project:admin') }),
        'DELETE /rest/projects/p2/members/u2': () => {
          removed = true;
          return { status: 200, body: { removed: true } };
        },
      });
      const { wrapper } = await mountSettings();
      const rows = wrapper.findAll('[data-test="member-row"]');
      await rows[1]?.get('[data-test="member-remove"]').trigger('click');
      await flushPromises();
      expect(inBody('[role="dialog"]')?.textContent).toContain('Ola Nowak');
      // "Anuluj" changes nothing.
      [...body().querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((b) => b.textContent?.trim() === 'Anuluj')
        ?.click();
      await flushPromises();
      expect(inBody('[role="dialog"]')).toBeNull();
      expect(requested(fetch, 'DELETE', '/rest/projects/p2/members/u2')).toHaveLength(0);

      await wrapper
        .findAll('[data-test="member-row"]')[1]
        ?.get('[data-test="member-remove"]')
        .trigger('click');
      await flushPromises();
      inBody('[data-test="member-remove-confirm"]')?.click();
      await flushPromises();
      expect(requested(fetch, 'DELETE', '/rest/projects/p2/members/u2')).toHaveLength(1);
      expect(inBody('[role="dialog"]')).toBeNull();
      expect(wrapper.findAll('[data-test="member-row"]')).toHaveLength(2);
      expect(wrapper.text()).not.toContain('Ola Nowak');
    });

    it('inviting someone who is already a member → a clear message', async () => {
      stub('project:admin', {
        'POST /rest/projects/p2/invitations': { status: 409, body: { message: 'User is already a member' } },
      });
      const { wrapper } = await mountSettings();
      await typeInto(wrapper, '[data-test="invite-email"] input', 'ola@firma.pl');
      await wrapper.get('[data-test="invite-form"]').trigger('submit');
      await flushPromises();
      expect(wrapper.text()).toContain('Ta osoba jest już członkiem projektu.');
      expect(wrapper.text()).not.toContain('Zaproszenie wysłane');
    });

    it('deleting a project that is already gone → "not found"', async () => {
      stub('project:admin', { 'DELETE /rest/projects/p2': GONE });
      const { wrapper } = await mountSettings();
      await wrapper.get('[data-test="delete"]').trigger('click');
      await flushPromises();
      typeInBody('[data-test="delete-name"] input', 'Biuro');
      await flushPromises();
      inBody<HTMLButtonElement>('[data-test="delete-confirm"]')?.click();
      await flushPromises();
      expect(wrapper.text()).toContain('Projekt nie istnieje albo nie masz do niego dostępu.');
      expect(wrapper.find('h1').text()).toBe('Projekt nie istnieje albo nie masz do niego dostępu.');
    });

    it('2FA turned off elsewhere: "Current password is required" switches the transfer to the password', async () => {
      const fetch = stub('project:admin', {
        'POST /rest/projects/p2/transfer': (init) =>
          sentBody(init).currentPassword
            ? { status: 200, body: { email: 'ola@firma.pl', expiresAt: '2026-11-05T10:00:00.000Z' } }
            : { status: 400, body: { message: 'Current password is required' } },
        'GET /rest/login': { status: 200, body: publicUser({ mfaEnabled: false }) },
      });
      const { wrapper, auth } = await mountSettings(publicUser({ mfaEnabled: true }));
      await wrapper.get('[data-test="transfer"]').trigger('click');
      await flushPromises();
      typeInBody('[data-test="transfer-email"] input', 'ola@firma.pl');
      typeInBody('[data-test="transfer-mfa"] input', '123456');
      inBody<HTMLFormElement>('[data-test="transfer-form"]')?.requestSubmit();
      await flushPromises();
      expect(inBody('[data-test="transfer-mfa"]')).toBeNull();
      expect(inBody('[role="dialog"]')?.textContent).toContain('Podaj obecne hasło.');
      expect(auth.user?.mfaEnabled).toBe(false);
      typeInBody('[data-test="transfer-password"] input', 'Haslo1234');
      inBody<HTMLFormElement>('[data-test="transfer-form"]')?.requestSubmit();
      await flushPromises();
      const calls = requested(fetch, 'POST', '/rest/projects/p2/transfer');
      expect(sentBody(calls.at(-1)?.[1])).toEqual({ email: 'ola@firma.pl', currentPassword: 'Haslo1234' });
      expect(inBody('[role="dialog"]')).toBeNull();
    });

    it('2FA turned on elsewhere: code 998 switches the transfer to the code', async () => {
      stub('project:admin', {
        'POST /rest/projects/p2/transfer': { status: 400, body: { message: 'MFA required', code: 998 } },
        'GET /rest/login': { status: 200, body: publicUser({ mfaEnabled: true }) },
      });
      const { wrapper } = await mountSettings();
      await wrapper.get('[data-test="transfer"]').trigger('click');
      await flushPromises();
      typeInBody('[data-test="transfer-email"] input', 'ola@firma.pl');
      typeInBody('[data-test="transfer-password"] input', 'Haslo1234');
      inBody<HTMLFormElement>('[data-test="transfer-form"]')?.requestSubmit();
      await flushPromises();
      expect(inBody('[data-test="transfer-password"]')).toBeNull();
      expect(inBody('[data-test="transfer-mfa"]')).not.toBeNull();
    });

    it('the icon button names the current icon', async () => {
      stub('project:admin');
      const { wrapper } = await mountSettings();
      expect(wrapper.get('[data-test="icon-picker"]').attributes('aria-label')).toBe(
        'Wybierz ikonę projektu (obecna: 🏢)',
      );
    });

    it('changes a member role', async () => {
      const changed = project('project:admin');
      changed.members[1] = member('u2', 'Ola', 'project:viewer');
      const fetch = stub('project:admin', {
        'PATCH /rest/projects/p2/members/u2': { status: 200, body: changed },
      });
      const { wrapper } = await mountSettings();
      await wrapper.findAll('[data-test="member-role"] select')[0]?.setValue('project:viewer');
      await flushPromises();
      const [call] = requested(fetch, 'PATCH', '/rest/projects/p2/members/u2');
      expect(sentBody(call?.[1])).toEqual({ role: 'project:viewer' });
    });

    it('saves name, icon and description', async () => {
      const fetch = stub('project:admin', {
        'PATCH /rest/projects/p2': { status: 200, body: { ...project('project:admin'), name: 'Biuro 2' } },
      });
      const { wrapper } = await mountSettings();
      expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeDefined();
      await typeInto(wrapper, '[data-test="project-name"] input', 'Biuro 2');
      await wrapper.get('[data-test="info-form"]').trigger('submit');
      await flushPromises();
      const [call] = requested(fetch, 'PATCH', '/rest/projects/p2');
      expect(sentBody(call?.[1])).toEqual({
        name: 'Biuro 2',
        icon: { type: 'emoji', value: '🏢' },
        description: 'Sprawy biura',
      });
      expect(wrapper.text()).toContain('Zapisano zmiany.');
    });

    it('invites by email and role without revealing whether the address has an account', async () => {
      const fetch = stub('project:admin', {
        'POST /rest/projects/p2/invitations': {
          status: 200,
          body: { email: 'ewa@firma.pl', status: 'invited' },
        },
      });
      const { wrapper } = await mountSettings();
      expect(wrapper.text()).toContain('nowa@firma.pl');
      await typeInto(wrapper, '[data-test="invite-email"] input', 'Ewa@Firma.pl');
      await wrapper.get('[data-test="invite-role"] select').setValue('project:viewer');
      await wrapper.get('[data-test="invite-form"]').trigger('submit');
      await flushPromises();
      const [call] = requested(fetch, 'POST', '/rest/projects/p2/invitations');
      expect(sentBody(call?.[1])).toEqual({ email: 'Ewa@Firma.pl', role: 'project:viewer' });
      expect(wrapper.text()).toContain('Zaproszenie wysłane na adres ewa@firma.pl.');
      expect(requested(fetch, 'GET', '/rest/projects/p2/invitations').length).toBeGreaterThan(1);
    });

    it('cancels a pending invitation', async () => {
      const fetch = stub('project:admin', {
        'DELETE /rest/projects/p2/invitations/i1': { status: 200, body: { deleted: true } },
      });
      const { wrapper } = await mountSettings();
      await wrapper.get('[data-test="invitation-cancel"]').trigger('click');
      await flushPromises();
      expect(requested(fetch, 'DELETE', '/rest/projects/p2/invitations/i1')).toHaveLength(1);
    });

    it('transfer asks for the current password and shows the pending transfer', async () => {
      const fetch = stub('project:admin', {
        'POST /rest/projects/p2/transfer': {
          status: 200,
          body: { email: 'ola@firma.pl', expiresAt: '2026-11-05T10:00:00.000Z' },
        },
      });
      const { wrapper } = await mountSettings();
      expect(wrapper.text()).toContain('zostaniesz w projekcie edytorem');
      await wrapper.get('[data-test="transfer"]').trigger('click');
      await flushPromises();
      const dialog = inBody('[role="dialog"]');
      expect(dialog?.textContent).toContain('Twoje obecne hasło');
      expect(dialog?.textContent).not.toContain('Kod z aplikacji');
      const email = inBody<HTMLInputElement>('[data-test="transfer-email"] input');
      const password = inBody<HTMLInputElement>('[data-test="transfer-password"] input');
      if (!email || !password) throw new Error('fields missing');
      email.value = 'ola@firma.pl';
      email.dispatchEvent(new Event('input'));
      password.value = 'Haslo1234';
      password.dispatchEvent(new Event('input'));
      inBody<HTMLFormElement>('[data-test="transfer-form"]')?.requestSubmit();
      await flushPromises();
      const [call] = requested(fetch, 'POST', '/rest/projects/p2/transfer');
      expect(sentBody(call?.[1])).toEqual({ email: 'ola@firma.pl', currentPassword: 'Haslo1234' });
      expect(inBody('[role="dialog"]')).toBeNull();
      expect(wrapper.get('[data-test="transfer-pending"]').text()).toContain('ola@firma.pl');
    });

    it('with 2FA on, the transfer asks for the code instead of the password', async () => {
      const fetch = stub('project:admin', {
        'POST /rest/projects/p2/transfer': {
          status: 400,
          body: { message: 'Invalid two-factor code' },
        },
      });
      const { wrapper } = await mountSettings(publicUser({ mfaEnabled: true }));
      await wrapper.get('[data-test="transfer"]').trigger('click');
      await flushPromises();
      expect(inBody('[data-test="transfer-password"]')).toBeNull();
      const email = inBody<HTMLInputElement>('[data-test="transfer-email"] input');
      const code = inBody<HTMLInputElement>('[data-test="transfer-mfa"] input');
      if (!email || !code) throw new Error('fields missing');
      email.value = 'ola@firma.pl';
      email.dispatchEvent(new Event('input'));
      code.value = '123456';
      code.dispatchEvent(new Event('input'));
      inBody<HTMLFormElement>('[data-test="transfer-form"]')?.requestSubmit();
      await flushPromises();
      const [call] = requested(fetch, 'POST', '/rest/projects/p2/transfer');
      expect(sentBody(call?.[1])).toEqual({ email: 'ola@firma.pl', mfaCode: '123456' });
      expect(inBody('[role="dialog"]')?.textContent).toContain('Nieprawidłowy kod.');
    });

    it('cancels a pending transfer', async () => {
      const fetch = stub('project:admin', {
        'GET /rest/projects/p2/transfer': {
          status: 200,
          body: {
            email: 'ola@firma.pl',
            expiresAt: '2026-11-05T10:00:00.000Z',
            createdAt: '2026-10-29T10:00:00.000Z',
          },
        },
        'DELETE /rest/projects/p2/transfer': { status: 200, body: { deleted: true } },
      });
      const { wrapper } = await mountSettings();
      expect(wrapper.get('[data-test="transfer-pending"]').text()).toContain('ola@firma.pl');
      await wrapper.get('[data-test="transfer-cancel"]').trigger('click');
      await flushPromises();
      expect(requested(fetch, 'DELETE', '/rest/projects/p2/transfer')).toHaveLength(1);
      expect(wrapper.find('[data-test="transfer-pending"]').exists()).toBe(false);
    });

    it('deletes only after the project name is typed', async () => {
      const fetch = stub('project:admin', {
        'DELETE /rest/projects/p2': { status: 200, body: { deleted: true } },
      });
      const { wrapper, router } = await mountSettings();
      await wrapper.get('[data-test="delete"]').trigger('click');
      await flushPromises();
      const confirm = inBody<HTMLButtonElement>('[data-test="delete-confirm"]');
      expect(confirm?.disabled).toBe(true);
      const input = inBody<HTMLInputElement>('[data-test="delete-name"] input');
      if (!input) throw new Error('field missing');
      input.value = 'Biuro';
      input.dispatchEvent(new Event('input'));
      await flushPromises();
      expect(confirm?.disabled).toBe(false);
      confirm?.click();
      await flushPromises();
      expect(requested(fetch, 'DELETE', '/rest/projects/p2')).toHaveLength(1);
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'));
    });
  });

  it('personal project: only the icon can be changed, no members management', async () => {
    const personal: ProjectDetails = {
      id: 'p1',
      name: 'Jan Nowak <jan@firma.pl>',
      type: 'personal',
      icon: null,
      description: null,
      role: 'project:personalOwner',
      memberCount: 1,
      members: [member('u1', 'Jan', 'project:personalOwner')],
    };
    vi.stubGlobal('fetch', vi.fn(fakeServer({ 'GET /rest/projects/p1': { status: 200, body: personal } })));
    const { wrapper } = await mountView(ProjectSettingsView, {
      path: '/projects/p1/settings',
      user: publicUser(),
    });
    expect(wrapper.text()).toContain('W projekcie osobistym możesz zmienić tylko ikonę.');
    // The header already says "Osobiste": the stored name (with the email) is not shown.
    expect(wrapper.find('[data-test="project-name"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('<jan@firma.pl>');
    expect(wrapper.get('[data-test="icon-picker"]').attributes('aria-label')).toBe(
      'Wybierz ikonę projektu (obecnie bez ikony)',
    );
    expect(wrapper.find('[data-test="project-description"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="icon-picker"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-test="invite-section"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="leave-section"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Strefa niebezpieczna');
  });

  it('a project that does not exist or is not accessible → a friendly message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(fakeServer({ 'GET /rest/projects/p2': { status: 404, body: { message: 'Project not found' } } })),
    );
    const { wrapper } = await mountSettings();
    expect(wrapper.text()).toContain('Projekt nie istnieje albo nie masz do niego dostępu.');
    expect(wrapper.get('h1').text()).toBe('Projekt nie istnieje albo nie masz do niego dostępu.');
  });
});
