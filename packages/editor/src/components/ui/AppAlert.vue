<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'info' | 'success' | 'warning' | 'danger' }>(), { variant: 'info' });
</script>

<template>
  <div class="app-alert" :class="`app-alert--${variant}`" :role="variant === 'danger' ? 'alert' : 'status'">
    <slot />
  </div>
</template>

<style scoped>
.app-alert {
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid;
  border-radius: var(--radius-md);
  font-size: var(--font-size-md);
}
.app-alert--info {
  background: var(--color-info-bg);
  border-color: var(--color-info-border);
  color: var(--color-text);
}
.app-alert--success {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-text);
}
.app-alert--warning {
  background: var(--color-warning-bg);
  border-color: var(--color-warning-border);
  color: var(--color-text);
}
.app-alert--danger {
  background: var(--color-danger-bg);
  border-color: var(--color-danger-border);
  color: var(--color-danger);
}
</style>
