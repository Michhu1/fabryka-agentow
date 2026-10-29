import type { MfaSetup } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import MfaSetupDialog from './MfaSetupDialog.vue';

const SETUP: MfaSetup = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUrl: 'otpauth://totp/moj-n8n:jan%40firma.pl?issuer=moj-n8n&secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  recoveryCodes: ['abcd-efgh-ijkl', 'mnop-qrst-uvwx', '0123-4567-89ab'],
};

const inBody = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

function click(selector: string) {
  const element = inBody<HTMLButtonElement>(selector);
  if (!element) throw new Error(`${selector} not found`);
  element.click();
  return flushPromises();
}

function type(selector: string, value: string) {
  const input = inBody<HTMLInputElement>(selector);
  if (!input) throw new Error(`${selector} not found`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  return flushPromises();
}

describe('MfaSetupDialog', () => {
  let blobs: Blob[];

  beforeEach(() => {
    blobs = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:codes';
    });
    URL.revokeObjectURL = vi.fn();
    // jsdom cannot "navigate" to the blob: link of the download.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('steps QR → recovery codes → code; "Włącz" is disabled until 6 digits; enabling updates the user', async () => {
    const fetch = vi.fn(
      fakeServer({
        'POST /rest/mfa/setup': { status: 200, body: SETUP },
        'POST /rest/mfa/enable': { status: 200, body: publicUser({ mfaEnabled: true }) },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const { wrapper, auth } = await mountView(MfaSetupDialog, {
      user: publicUser(),
      props: { open: true },
      attach: true,
    });
    await vi.waitFor(() => expect(inBody('[data-test="mfa-qr"]')).not.toBeNull());

    // Step 1: the QR code and the secret for typing it in by hand.
    const qr = inBody<HTMLImageElement>('[data-test="mfa-qr"]');
    expect(qr?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(qr?.getAttribute('alt')).toBeTruthy();
    expect(inBody('[data-test="mfa-secret"]')?.textContent).toContain(SETUP.secret);
    expect(inBody('[data-test="mfa-codes"]')).toBeNull();
    expect(inBody('[data-test="mfa-code"]')).toBeNull();
    await click('[data-test="mfa-next"]');

    // Step 2: the recovery codes; "Dalej" only after saving them. Esc does not lose them.
    const pressEscape = async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await flushPromises();
    };
    await pressEscape();
    expect(wrapper.emitted('update:open')).toBeUndefined();
    const codes = inBody('[data-test="mfa-codes"]')?.textContent ?? '';
    for (const code of SETUP.recoveryCodes) expect(codes).toContain(code);
    expect(inBody<HTMLButtonElement>('[data-test="mfa-next"]')?.disabled).toBe(true);
    await click('[data-test="mfa-download"]');
    expect(blobs).toHaveLength(1);
    const file = await blobs[0]?.text();
    for (const code of SETUP.recoveryCodes) expect(file).toContain(code);
    expect(inBody<HTMLButtonElement>('[data-test="mfa-next"]')?.disabled).toBe(false);
    await click('[data-test="mfa-next"]');

    // Step 3: the code from the app (Esc does not close it either).
    await pressEscape();
    expect(wrapper.emitted('update:open')).toBeUndefined();
    const enable = () => inBody<HTMLButtonElement>('[data-test="mfa-enable"]');
    expect(enable()?.textContent).toContain('Włącz');
    expect(enable()?.disabled).toBe(true);
    await type('[data-test="mfa-code"] input', '12345');
    expect(enable()?.disabled).toBe(true);
    await type('[data-test="mfa-code"] input', '12a456');
    expect(enable()?.disabled).toBe(true);
    await type('[data-test="mfa-code"] input', '123456');
    expect(enable()?.disabled).toBe(false);
    await click('[data-test="mfa-enable"]');

    const enableCall = fetch.mock.calls.find(([url]) => url === '/rest/mfa/enable');
    expect(sentBody(enableCall?.[1])).toEqual({ mfaCode: '123456' });
    expect(auth.user?.mfaEnabled).toBe(true);
    expect(wrapper.emitted('enabled')).toHaveLength(1);
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('a wrong code shows the error and keeps the dialog on the code step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeServer({
          'POST /rest/mfa/setup': { status: 200, body: SETUP },
          'POST /rest/mfa/enable': { status: 400, body: { message: 'Invalid two-factor code' } },
        }),
      ),
    );
    const { wrapper, auth } = await mountView(MfaSetupDialog, {
      user: publicUser(),
      props: { open: true },
      attach: true,
    });
    await vi.waitFor(() => expect(inBody('[data-test="mfa-qr"]')).not.toBeNull());
    await click('[data-test="mfa-next"]');
    await click('[data-test="mfa-copy"]');
    // No clipboard in jsdom: copying fails, the codes stay on screen and downloading still works.
    expect(inBody<HTMLButtonElement>('[data-test="mfa-next"]')?.disabled).toBe(true);
    await click('[data-test="mfa-download"]');
    await click('[data-test="mfa-next"]');
    await type('[data-test="mfa-code"] input', '000000');
    await click('[data-test="mfa-enable"]');
    expect(document.body.textContent).toContain('Nieprawidłowy kod');
    expect(inBody('[data-test="mfa-code"]')).not.toBeNull();
    expect(auth.user?.mfaEnabled).toBe(false);
    expect(wrapper.emitted('enabled')).toBeUndefined();
  });
});
