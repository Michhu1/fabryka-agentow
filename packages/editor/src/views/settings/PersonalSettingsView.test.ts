import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import PersonalSettingsView from './PersonalSettingsView.vue';

const inBody = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

async function type(selector: string, value: string) {
  const input = inBody<HTMLInputElement>(selector);
  if (!input) throw new Error(`${selector} not found`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
}

async function submit(selector: string) {
  const form = inBody<HTMLFormElement>(selector);
  if (!form) throw new Error(`${selector} not found`);
  form.dispatchEvent(new Event('submit'));
  await flushPromises();
}

function mountPersonal(user = publicUser()) {
  return mountView(PersonalSettingsView, { path: '/settings/personal', user, attach: true });
}

describe('PersonalSettingsView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('a wrong current password (401) is a form error, never a sign-out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'PATCH /rest/me/password': { status: 401, body: { message: 'Current password is incorrect' } },
        }),
      ),
    );
    const { auth } = await mountPersonal();
    await type('[data-test="current-password"] input', 'zle-haslo');
    await type('[data-test="new-password"] input', 'NoweHaslo1');
    await type('[data-test="confirm-password"] input', 'NoweHaslo1');
    await submit('[data-test="password-form"]');
    expect(document.body.textContent).toContain('Obecne hasło jest nieprawidłowe.');
    expect(auth.user).not.toBeNull();
  });

  it('password change: the policy and the confirmation are checked before sending', async () => {
    const fetch = vi.fn(fakeServer({}));
    vi.stubGlobal('fetch', fetch);
    await mountPersonal();
    await type('[data-test="current-password"] input', 'Haslo123');
    await type('[data-test="new-password"] input', 'krotkie');
    await submit('[data-test="password-form"]');
    expect(document.body.textContent).toContain('Hasło musi mieć 8–64 znaki');
    await type('[data-test="new-password"] input', 'NoweHaslo1');
    await type('[data-test="confirm-password"] input', 'NoweHaslo2');
    await submit('[data-test="password-form"]');
    expect(document.body.textContent).toContain('Hasła nie są takie same.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('email change with 2FA on asks for the code ("MFA required" 998 also shows the field)', async () => {
    const changed = publicUser({ email: 'nowy@firma.pl', mfaEnabled: true });
    const fetch = vi.fn(
      fakeServer({
        'PATCH /rest/me': (init) =>
          sentBody(init).mfaCode
            ? { status: 200, body: changed }
            : { status: 400, body: { message: 'MFA required', code: 998 } },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    // The store still thinks 2FA is off (turned on in another window).
    const { auth } = await mountPersonal();
    expect(inBody('[data-test="email-mfa"]')).toBeNull();
    await type('[data-test="new-email"] input', 'nowy@firma.pl');
    await type('[data-test="email-password"] input', 'Haslo123');
    await submit('[data-test="email-form"]');
    expect(inBody('[data-test="email-mfa"]')).not.toBeNull();
    await type('[data-test="email-mfa"] input', '123 456');
    await submit('[data-test="email-form"]');
    const last = fetch.mock.calls.at(-1);
    expect(sentBody(last?.[1])).toEqual({
      email: 'nowy@firma.pl',
      currentPassword: 'Haslo123',
      mfaCode: '123456',
    });
    expect(auth.user?.email).toBe('nowy@firma.pl');
    expect(document.body.textContent).toContain('zmieniony na nowy@firma.pl');
  });

  it('theme: applied at once and saved to the account', async () => {
    const fetch = vi.fn(
      fakeServer({
        'PATCH /rest/me/settings': { status: 200, body: publicUser({ settings: { theme: 'dark' } }) },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const { auth } = await mountPersonal();
    const dark = inBody<HTMLInputElement>('[data-test="theme-dark"]');
    if (!dark) throw new Error('no dark option');
    dark.checked = true;
    dark.dispatchEvent(new Event('change'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await flushPromises();
    expect(sentBody(fetch.mock.calls[0]?.[1])).toEqual({ theme: 'dark' });
    expect(auth.user?.settings.theme).toBe('dark');
  });

  function pickTheme(option: string) {
    const radio = inBody<HTMLInputElement>(`[data-test="theme-${option}"]`);
    if (!radio) throw new Error(`no ${option} option`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  }
  const radio = (option: string) => inBody<HTMLInputElement>(`[data-test="theme-${option}"]`);

  it('theme: never disabled while saving (keyboard focus stays), only marked busy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    await mountPersonal();
    radio('light')?.focus();
    pickTheme('light');
    await flushPromises();
    const fieldset = inBody<HTMLFieldSetElement>('[data-test="theme"]');
    expect(fieldset?.disabled).toBe(false);
    expect(fieldset?.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(radio('light'));
  });

  it('theme: a failed save puts both the look and the checked radio back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'PATCH /rest/me/settings': { status: 500, body: { message: 'Internal server error' } },
        }),
      ),
    );
    await mountPersonal(publicUser({ settings: { theme: 'light' } }));
    pickTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await flushPromises();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(radio('light')?.checked).toBe(true);
    expect(radio('dark')?.checked).toBe(false);
    expect(document.body.textContent).toContain('Coś poszło nie tak.');
  });

  it('theme: quick changes — the latest choice wins, an older answer arriving last is ignored', async () => {
    const answers: ((theme: string) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answers.push((theme) =>
              resolve(
                new Response(JSON.stringify(publicUser({ settings: { theme: theme as 'dark' } })), {
                  status: 200,
                }),
              ),
            );
          }),
      ),
    );
    const { auth } = await mountPersonal();
    pickTheme('light');
    pickTheme('dark');
    await flushPromises();
    expect(answers).toHaveLength(2);
    answers[1]?.('dark');
    await flushPromises();
    answers[0]?.('light');
    await flushPromises();
    expect(auth.user?.settings.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(radio('dark')?.checked).toBe(true);
    expect(inBody('[data-test="theme"]')?.getAttribute('aria-busy')).toBe('false');
  });

  it('2FA on: shows the state and offers turning it off with a code', async () => {
    const fetch = vi.fn(
      fakeServer({ 'POST /rest/mfa/disable': { status: 200, body: publicUser({ mfaEnabled: false }) } }),
    );
    vi.stubGlobal('fetch', fetch);
    const { auth } = await mountPersonal(publicUser({ mfaEnabled: true }));
    expect(inBody('[data-test="mfa-status"]')?.textContent).toContain('Włączona');
    inBody<HTMLButtonElement>('[data-test="mfa-disable-open"]')?.click();
    await flushPromises();
    await type('[data-test="mfa-disable-code"] input', '654321');
    await submit('[data-test="mfa-disable-form"]');
    expect(sentBody(fetch.mock.calls[0]?.[1])).toEqual({ mfaCode: '654321' });
    expect(auth.user?.mfaEnabled).toBe(false);
    expect(inBody('[data-test="mfa-status"]')?.textContent).toContain('Wyłączona');
  });

  it('2FA turned on elsewhere: "Włącz" re-reads the user and shows "Włączona"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'POST /rest/mfa/setup': {
            status: 400,
            body: { message: 'Two-factor authentication is already enabled' },
          },
          'GET /rest/login': { status: 200, body: publicUser({ mfaEnabled: true }) },
        }),
      ),
    );
    const { auth } = await mountPersonal();
    expect(inBody('[data-test="mfa-status"]')?.textContent).toContain('Wyłączona');
    inBody<HTMLButtonElement>('[data-test="mfa-enable-open"]')?.click();
    await flushPromises();
    await vi.waitFor(() => expect(auth.user?.mfaEnabled).toBe(true));
    await flushPromises();
    expect(inBody('[data-test="mfa-status"]')?.textContent).toContain('Włączona');
    expect(inBody('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Coś poszło nie tak');
  });

  it('2FA turned off elsewhere: "Wyłącz" re-reads the user and shows "Wyłączona"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'POST /rest/mfa/disable': {
            status: 400,
            body: { message: 'Two-factor authentication is not enabled' },
          },
          'GET /rest/login': { status: 200, body: publicUser({ mfaEnabled: false }) },
        }),
      ),
    );
    const { auth } = await mountPersonal(publicUser({ mfaEnabled: true }));
    inBody<HTMLButtonElement>('[data-test="mfa-disable-open"]')?.click();
    await flushPromises();
    await type('[data-test="mfa-disable-code"] input', '654321');
    await submit('[data-test="mfa-disable-form"]');
    expect(auth.user?.mfaEnabled).toBe(false);
    expect(inBody('[data-test="mfa-status"]')?.textContent).toContain('Wyłączona');
    expect(inBody('[role="dialog"]')).toBeNull();
  });
});
