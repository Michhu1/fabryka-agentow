<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { useI18n } from 'vue-i18n';

/**
 * A modal dialog (reka-ui: focus trapped inside, Esc and the close button close it, focus returns to
 * what opened it). `description` explains what the dialog is for (screen readers announce it).
 * `dismissible: false` keeps it open on Esc and on a click outside (for content shown only once, like a
 * new API key or recovery codes): only its own buttons and the X close it then.
 */
const props = withDefaults(defineProps<{ title: string; description: string; dismissible?: boolean }>(), {
  dismissible: true,
});
const open = defineModel<boolean>('open', { default: false });
const { t } = useI18n();

function keepOpen(event: Event) {
  if (!props.dismissible) event.preventDefault();
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="app-dialog__overlay" />
      <DialogContent class="app-dialog" @interact-outside="keepOpen" @escape-key-down="keepOpen">
        <header class="app-dialog__header">
          <DialogTitle class="app-dialog__title">{{ title }}</DialogTitle>
          <DialogClose class="app-dialog__close" :aria-label="t('common.close')">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </DialogClose>
        </header>
        <DialogDescription class="app-dialog__description">{{ description }}</DialogDescription>
        <div class="app-dialog__body">
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
/* Not scoped: the dialog is teleported to <body>. */
.app-dialog__overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: var(--color-overlay);
}
.app-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 51;
  display: grid;
  gap: var(--space-4);
  width: min(var(--dialog-width), calc(100vw - 2 * var(--space-4)));
  max-height: calc(100vh - 2 * var(--space-8));
  overflow: auto;
  padding: var(--space-6);
  transform: translate(-50%, -50%);
  background: var(--color-surface);
  color: var(--color-text);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
}
.app-dialog:focus {
  outline: none;
}
.app-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.app-dialog__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.app-dialog__close {
  display: inline-grid;
  place-items: center;
  width: var(--icon-size-sm);
  height: var(--icon-size-sm);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.app-dialog__close:hover {
  background: var(--color-surface-muted);
  color: var(--color-text);
}
.app-dialog__description {
  margin: 0;
  color: var(--color-text-muted);
}
.app-dialog__body {
  display: grid;
  gap: var(--space-4);
}
</style>
