import type { ApiKeySummary, CreatedApiKey } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeServer, publicUser, sentBody } from '../../test/fixtures';
import { mountView } from '../../test/mount';
import ApiKeysSettingsView from './ApiKeysSettingsView.vue';

const RAW = 'mn8_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';

function summary(id: string, label: string, extra: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id,
    label,
    hint: 'wxyz',
    createdAt: '2026-10-20T10:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    ...extra,
  };
}

const inBody = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

async function click(selector: string) {
  const element = inBody<HTMLElement>(selector);
  if (!element) throw new Error(`${selector} not found`);
  element.click();
  await flushPromises();
}

async function type(selector: string, value: string) {
  const input = inBody<HTMLInputElement>(selector);
  if (!input) throw new Error(`${selector} not found`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
}

function mountKeys() {
  return mountView(ApiKeysSettingsView, { path: '/settings/api', user: publicUser(), attach: true });
}

describe('ApiKeysSettingsView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows the new key once with "Kopiuj" and a warning; the list shows only …hint', async () => {
    const created: CreatedApiKey = { ...summary('k2', 'Zapier', { hint: 'abcd' }), rawKey: RAW };
    const fetch = vi.fn(
      fakeServer({
        'GET /rest/api-keys': { status: 200, body: [summary('k1', 'Make')] },
        'POST /rest/api-keys': { status: 200, body: created },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await mountKeys();
    expect(document.body.textContent).toContain('…wxyz');

    await click('[data-test="api-key-create"]');
    await type('[data-test="api-key-label"] input', 'Zapier');
    await click('[data-test="api-key-submit"]');
    const body = sentBody(
      fetch.mock.calls.find(([url, init]) => url === '/rest/api-keys' && init?.method === 'POST')?.[1],
    );
    expect(body.label).toBe('Zapier');
    expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);

    expect(inBody<HTMLInputElement>('[data-test="api-key-raw"]')?.value).toBe(RAW);
    expect(inBody('[data-test="api-key-copy"]')?.textContent).toContain('Kopiuj');
    expect(inBody('[role="dialog"]')?.textContent).toContain('tylko ten jeden raz');
    // The row behind the dialog already lists the key, without the key itself.
    const rows = [...document.body.querySelectorAll('[data-test="api-key-row"]')].map(
      (r) => r.textContent ?? '',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Zapier');
    expect(rows[0]).toContain('…abcd');
    expect(rows.join()).not.toContain(RAW);

    // Shown once: Esc does not throw it away by accident, only "Gotowe" (or the X) closes it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(inBody<HTMLInputElement>('[data-test="api-key-raw"]')?.value).toBe(RAW);

    await click('[data-test="api-key-done"]');
    expect(inBody('[data-test="api-key-raw"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(RAW);

    // Opening the dialog again starts empty: the key is never shown twice.
    await click('[data-test="api-key-create"]');
    expect(inBody('[data-test="api-key-raw"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(RAW);
  });

  it('no expiry sends expiresAt null; the server limit message is shown in Polish', async () => {
    const fetch = vi.fn(
      fakeServer({
        'GET /rest/api-keys': { status: 200, body: [] },
        'POST /rest/api-keys': { status: 400, body: { message: 'API key limit reached (10)' } },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await mountKeys();
    await click('[data-test="api-key-create"]');
    await type('[data-test="api-key-label"] input', 'CRM');
    const select = inBody<HTMLSelectElement>('[data-test="api-key-expiry"] select');
    if (!select) throw new Error('no select');
    select.value = 'never';
    select.dispatchEvent(new Event('change'));
    await click('[data-test="api-key-submit"]');
    const call = fetch.mock.calls.find(([url, init]) => url === '/rest/api-keys' && init?.method === 'POST');
    expect(sentBody(call?.[1])).toEqual({ label: 'CRM', expiresAt: null });
    expect(inBody('[role="dialog"]')?.textContent).toContain('Osiągnięto limit kluczy API');
  });

  it('at 10 keys "Utwórz klucz" is disabled and the limit is explained', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => summary(`k${i}`, `Klucz ${i}`));
    vi.stubGlobal('fetch', vi.fn(fakeServer({ 'GET /rest/api-keys': { status: 200, body: ten } })));
    await mountKeys();
    expect(inBody<HTMLButtonElement>('[data-test="api-key-create"]')?.disabled).toBe(true);
    expect(inBody('[data-test="api-key-limit"]')?.textContent).toContain('10');
  });

  it('deletes a key after confirmation', async () => {
    const fetch = vi.fn(
      fakeServer({
        'GET /rest/api-keys': { status: 200, body: [summary('k1', 'Make')] },
        'DELETE /rest/api-keys/k1': { status: 200, body: { deleted: true } },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await mountKeys();
    await click('[data-test="api-key-delete"]');
    expect(inBody('[role="dialog"]')?.textContent).toContain('stracą dostęp');
    await click('[data-test="api-key-delete-confirm"]');
    expect(
      fetch.mock.calls.some(([url, init]) => url === '/rest/api-keys/k1' && init?.method === 'DELETE'),
    ).toBe(true);
    expect(document.body.querySelectorAll('[data-test="api-key-row"]')).toHaveLength(0);
  });
});
