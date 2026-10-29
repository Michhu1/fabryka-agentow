<script setup lang="ts">
import type { ProjectSummary } from '@app/shared';
import { useI18n } from 'vue-i18n';
import { projectRoleKey } from '../../i18n';
import ProjectIconView from './ProjectIconView.vue';
import { useProjectName } from './project-display';

/** Icon, name, description and the user's role of a project, with actions on the right. */
defineProps<{ project: ProjectSummary }>();
const { t } = useI18n();
const projectName = useProjectName();
</script>

<template>
  <header class="project-header">
    <div class="project-header__main">
      <ProjectIconView :project="project" size="lg" />
      <div class="project-header__text">
        <h1 class="project-header__name">{{ projectName(project) }}</h1>
        <p class="project-header__meta">
          <span v-if="project.type === 'team'">{{ t('projects.yourRole', { role: t(projectRoleKey(project.role)) }) }}</span>
          <span v-if="project.type === 'personal'">{{ t('projects.personalDescription') }}</span>
          <span v-else-if="project.description" class="project-header__description">{{ project.description }}</span>
        </p>
      </div>
    </div>
    <div v-if="$slots.default" class="project-header__actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.project-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.project-header__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.project-header__text {
  display: grid;
  min-width: 0;
}
.project-header__name {
  margin: 0;
  overflow: hidden;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-header__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.project-header__description {
  overflow-wrap: anywhere;
}
.project-header__actions {
  display: flex;
  gap: var(--space-2);
}
</style>
