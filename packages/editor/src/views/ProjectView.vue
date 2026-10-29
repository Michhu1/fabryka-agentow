<script setup lang="ts">
import type { ProjectDetails } from '@app/shared';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { ApiError } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import PageLayout from '../components/PageLayout.vue';
import ProjectHeader from '../components/projects/ProjectHeader.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppFormError from '../components/ui/AppFormError.vue';
import { useServerError } from '../i18n/server-errors';
import { useProjectsStore } from '../stores/projects';

/**
 * A project's page (`/projects/:projectId`): header with icon and name, and n8n's tabs — empty until
 * workflows, credentials and the rest arrive (M2+).
 */
const TABS = ['workflows', 'credentials', 'executions', 'variables', 'dataTables'] as const;

const { t } = useI18n();
const route = useRoute();
const projects = useProjectsStore();
const errorText = useServerError();

const projectId = String(route.params.projectId);
const project = ref<ProjectDetails | null>(null);
const state = ref<'loading' | 'ready' | 'not-found' | 'error'>('loading');
const error = ref<string | null>(null);
const tab = ref<(typeof TABS)[number]>('workflows');

onMounted(async () => {
  try {
    project.value = await projects.get(projectId);
    state.value = 'ready';
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) state.value = 'not-found';
    else {
      state.value = 'error';
      error.value = errorText(caught);
    }
  }
});
</script>

<template>
  <PageLayout>
    <p v-if="state === 'loading'" class="project__muted">{{ t('common.loading') }}</p>
    <EmptyState v-else-if="state === 'not-found'" :title="t('projects.notFound')" :level="1">
      <AppButton :to="{ name: 'home' }" variant="secondary">{{ t('projects.backToOverview') }}</AppButton>
    </EmptyState>
    <AppFormError v-else-if="state === 'error'" :message="error" />
    <template v-else-if="project">
      <ProjectHeader :project="project">
        <AppButton
          variant="secondary"
          :to="{ name: 'project-settings', params: { projectId: project.id } }"
          data-test="project-settings-link"
        >
          {{ t('projects.settingsButton') }}
        </AppButton>
      </ProjectHeader>

      <TabsRoot v-model="tab" class="project__tabs">
        <TabsList class="project__tab-list" :aria-label="t('projects.tabsLabel')">
          <TabsTrigger v-for="name in TABS" :key="name" :value="name" class="project__tab">
            {{ t(`projects.tabs.${name}`) }}
          </TabsTrigger>
        </TabsList>
        <TabsContent v-for="name in TABS" :key="name" :value="name" class="project__panel">
          <EmptyState :title="t('projects.comingSoon')" :text="t(`projects.comingSoonText.${name}`)" />
        </TabsContent>
      </TabsRoot>
    </template>
  </PageLayout>
</template>

<style scoped>
.project__muted {
  margin: 0;
  color: var(--color-text-muted);
}
.project__tabs {
  display: grid;
  gap: var(--space-4);
}
.project__tab-list {
  display: flex;
  gap: var(--space-1);
  overflow-x: auto;
  border-bottom: var(--border-width) solid var(--color-border);
}
.project__tab {
  margin-bottom: calc(-1 * var(--border-width));
  padding: var(--space-2) var(--space-3);
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  cursor: pointer;
}
.project__tab:hover {
  color: var(--color-text);
}
.project__tab[data-state='active'] {
  border-bottom-color: var(--color-primary);
  color: var(--color-text);
}
.project__panel:focus-visible {
  outline-offset: 4px;
}
</style>
