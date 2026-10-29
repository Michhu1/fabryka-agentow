<script setup lang="ts">
import type { ProjectSummary } from '@app/shared';

/** A project's emoji, or a neutral symbol when it has none. Decorative: the name is always next to it. */
withDefaults(defineProps<{ project: Pick<ProjectSummary, 'type' | 'icon'>; size?: 'sm' | 'md' | 'lg' }>(), {
  size: 'sm',
});
</script>

<template>
  <span class="project-icon" :class="`project-icon--${size}`" aria-hidden="true">
    <template v-if="project.icon">{{ project.icon.value }}</template>
    <svg v-else-if="project.type === 'personal'" viewBox="0 0 16 16" class="project-icon__symbol">
      <circle cx="8" cy="5.5" r="2.75" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M2.75 14c.6-2.9 2.7-4.4 5.25-4.4s4.65 1.5 5.25 4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
    <svg v-else viewBox="0 0 16 16" class="project-icon__symbol">
      <path d="M8 2 14 5.25 8 8.5 2 5.25Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      <path d="M2 8.25 8 11.5l6-3.25M2 11 8 14.25 14 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  </span>
</template>

<style scoped>
.project-icon {
  display: inline-grid;
  flex: none;
  place-items: center;
  line-height: 1;
  color: var(--color-text-muted);
}
.project-icon--sm {
  width: var(--icon-size-sm);
  height: var(--icon-size-sm);
  font-size: var(--font-size-lg);
}
.project-icon--md {
  width: var(--icon-size-md);
  height: var(--icon-size-md);
  font-size: var(--font-size-xl);
}
.project-icon--lg {
  width: var(--icon-size-lg);
  height: var(--icon-size-lg);
  font-size: var(--font-size-2xl);
}
.project-icon__symbol {
  width: 70%;
  height: 70%;
}
</style>
