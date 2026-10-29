<script setup lang="ts">
import { useId } from 'vue';

/** A titled card of a settings page; `danger` marks destructive actions ("Strefa niebezpieczna"). */
withDefaults(defineProps<{ title: string; description?: string; danger?: boolean }>(), { danger: false });
const id = useId();
</script>

<template>
  <section class="settings-section" :class="{ 'settings-section--danger': danger }" :aria-labelledby="id">
    <header class="settings-section__header">
      <h2 :id="id" class="settings-section__title">{{ title }}</h2>
      <p v-if="description" class="settings-section__description">{{ description }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.settings-section {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-6);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
}
.settings-section--danger {
  border-color: var(--color-danger-border);
}
.settings-section__header {
  display: grid;
  gap: var(--space-1);
}
.settings-section__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.settings-section--danger .settings-section__title {
  color: var(--color-danger);
}
.settings-section__description {
  max-width: 70ch;
  margin: 0;
  color: var(--color-text-muted);
}
@media (max-width: 720px) {
  .settings-section {
    padding: var(--space-4);
  }
}
</style>
