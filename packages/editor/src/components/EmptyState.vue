<script setup lang="ts">
/**
 * A calm box for "nothing here (yet)" and "not found", with optional actions below. `level` 1 when the
 * box is the whole page (a "not found" page needs its own h1), 2 inside a page.
 */
withDefaults(defineProps<{ title: string; text?: string; level?: 1 | 2 }>(), { level: 2 });
</script>

<template>
  <section class="empty-state">
    <component :is="`h${level}`" class="empty-state__title">{{ title }}</component>
    <p v-if="text" class="empty-state__text">{{ text }}</p>
    <div v-if="$slots.default" class="empty-state__actions">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-12) var(--space-6);
  text-align: center;
  background: var(--color-surface);
  border: var(--border-width) dashed var(--color-border-strong);
  border-radius: var(--radius-lg);
}
.empty-state__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.empty-state__text {
  max-width: 48ch;
  margin: 0;
  color: var(--color-text-muted);
}
.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
