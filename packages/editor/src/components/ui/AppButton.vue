<script setup lang="ts">
import { type RouteLocationRaw, RouterLink } from 'vue-router';

/**
 * A button; with `to` it is a link to that route that looks the same (navigation stays a link). A
 * disabled or loading one is always a real disabled button, never a link that still navigates.
 */
withDefaults(
  defineProps<{
    to?: RouteLocationRaw;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
    type?: 'button' | 'submit' | 'reset';
    loading?: boolean;
    disabled?: boolean;
    /** Full width of the container. */
    block?: boolean;
  }>(),
  { variant: 'primary', type: 'button', loading: false, disabled: false, block: false },
);
</script>

<template>
  <RouterLink
    v-if="to && !disabled && !loading"
    :to="to"
    class="app-button"
    :class="[`app-button--${variant}`, { 'app-button--block': block }]"
  >
    <slot />
  </RouterLink>
  <button
    v-else
    :type="type"
    class="app-button"
    :class="[`app-button--${variant}`, { 'app-button--block': block }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="app-button__spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.app-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: 0 var(--space-4);
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-md);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}
.app-button:hover {
  text-decoration: none;
}
.app-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.app-button--block {
  width: 100%;
}
.app-button--primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.app-button--primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}
.app-button--primary:active:not(:disabled) {
  background: var(--color-primary-active);
}
.app-button--secondary {
  background: var(--color-surface);
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.app-button--secondary:hover:not(:disabled) {
  background: var(--color-surface-muted);
}
.app-button--ghost {
  background: transparent;
  color: var(--color-text);
}
.app-button--ghost:hover:not(:disabled) {
  background: var(--color-surface-muted);
}
.app-button--danger {
  background: var(--color-danger);
  color: var(--color-on-primary);
}
.app-button--danger:hover:not(:disabled) {
  background: var(--color-danger-hover);
}
.app-button--link {
  min-height: auto;
  padding: 0;
  background: none;
  color: var(--color-link);
  font-weight: var(--font-weight-medium);
}
.app-button--link:hover:not(:disabled) {
  text-decoration: underline;
}
.app-button__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: app-button-spin 0.7s linear infinite;
}
@keyframes app-button-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .app-button__spinner {
    animation-duration: 2s;
  }
}
</style>
