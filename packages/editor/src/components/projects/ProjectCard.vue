<script setup lang="ts">
import type { ProjectSummary } from '@app/shared';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { projectRoleKey } from '../../i18n';
import ProjectIconView from './ProjectIconView.vue';
import { useProjectName } from './project-display';

/** One project in the overview: icon, name, the user's role and the number of members. */
defineProps<{ project: ProjectSummary }>();
const { t } = useI18n();
const projectName = useProjectName();
</script>

<template>
  <RouterLink :to="{ name: 'project', params: { projectId: project.id } }" class="project-card" data-test="project-card">
    <ProjectIconView :project="project" size="md" />
    <span class="project-card__body">
      <span class="project-card__name">{{ projectName(project) }}</span>
      <span class="project-card__meta">
        <span class="project-card__role">{{ t(projectRoleKey(project.role)) }}</span>
        <span v-if="project.type === 'team'">{{ t('overview.members', { count: project.memberCount }) }}</span>
      </span>
      <span v-if="project.type === 'personal'" class="project-card__description">
        {{ t('projects.personalDescription') }}
      </span>
      <span v-else-if="project.description" class="project-card__description">{{ project.description }}</span>
    </span>
  </RouterLink>
</template>

<style scoped>
.project-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text);
  transition: border-color var(--transition-fast);
}
.project-card:hover {
  border-color: var(--color-border-strong);
  text-decoration: none;
}
.project-card__body {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.project-card__name {
  overflow: hidden;
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.project-card__role {
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
}
.project-card__description {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
</style>
