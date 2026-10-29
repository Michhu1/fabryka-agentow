import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { i18n } from '../../i18n';
import AppDialog from './AppDialog.vue';

function mountDialog(dismissible?: boolean) {
  const open = ref(true);
  const Host = defineComponent(
    () => () =>
      h(
        AppDialog,
        {
          title: 'Tytuł',
          description: 'Opis',
          dismissible,
          open: open.value,
          'onUpdate:open': (value: boolean) => {
            open.value = value;
          },
        },
        () => h('p', 'Treść'),
      ),
  );
  mount(Host, { attachTo: document.body, global: { plugins: [i18n] } });
  return open;
}

const pressEscape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const closeButton = () => document.body.querySelector<HTMLButtonElement>('[aria-label="Zamknij"]');

describe('AppDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes on Esc by default', async () => {
    const open = mountDialog();
    await flushPromises();
    pressEscape();
    await flushPromises();
    expect(open.value).toBe(false);
  });

  it('dismissible=false: Esc does not close it, the X still does', async () => {
    const open = mountDialog(false);
    await flushPromises();
    pressEscape();
    await flushPromises();
    expect(open.value).toBe(true);
    expect(document.body.textContent).toContain('Treść');
    closeButton()?.click();
    await flushPromises();
    expect(open.value).toBe(false);
  });
});
