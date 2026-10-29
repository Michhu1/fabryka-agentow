<script setup lang="ts">
/** The content column of an app page: a header (title, subtitle, actions) and the page below. */
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <div class="page">
    <header v-if="title || $slots.title" class="page__header">
      <div class="page__heading">
        <slot name="title">
          <h1 class="page__title">{{ title }}</h1>
        </slot>
        <p v-if="subtitle" class="page__subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="page__actions">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.page {
  display: grid;
  gap: var(--space-6);
  width: 100%;
  max-width: var(--content-width);
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}
.page__header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.page__heading {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.page__title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
}
.page__subtitle {
  margin: 0;
  color: var(--color-text-muted);
}
.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
@media (max-width: 720px) {
  .page {
    padding: var(--space-6) var(--space-4);
  }
}
</style>
