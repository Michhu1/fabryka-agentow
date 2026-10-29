<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import EmptyState from '../components/EmptyState.vue';
import PageLayout from '../components/PageLayout.vue';
import CreateProjectDialog from '../components/projects/CreateProjectDialog.vue';
import ProjectCard from '../components/projects/ProjectCard.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppFormError from '../components/ui/AppFormError.vue';
import { useServerError } from '../i18n/server-errors';
import { useAuthStore } from '../stores/auth';
import { useProjectsStore } from '../stores/projects';

/** The start page (`/home`): a welcome and every project the user has access to, with their role. */
const { t } = useI18n();
const auth = useAuthStore();
const projects = useProjectsStore();
const errorText = useServerError();
const error = ref<string | null>(null);
const creating = ref(false);
const limitId = useId();

const atLimit = computed(() => auth.atTeamProjectLimit);

onMounted(async () => {
  try {
    await projects.ensureLoaded();
  } catch (caught) {
    error.value = `${t('overview.loadError')} ${errorText(caught)}`;
  }
});
</script>

<template>
  <PageLayout
    :title="t('overview.greeting', { name: auth.user?.firstName ?? '' })"
    :subtitle="t('overview.subtitle')"
  >
    <template #actions>
      <AppButton
        :disabled="atLimit"
        :aria-describedby="atLimit ? limitId : undefined"
        data-test="overview-new-project"
        @click="creating = true"
      >
        {{ t('nav.newProject') }}
      </AppButton>
    </template>

    <p v-if="atLimit" :id="limitId" class="overview__limit">{{ t('nav.limitReached') }}</p>
    <AppFormError :message="error" />

    <section class="overview__section" aria-labelledby="overview-projects">
      <h2 id="overview-projects" class="overview__heading">{{ t('overview.projects') }}</h2>
      <p v-if="!projects.loaded && !error" class="overview__muted">{{ t('common.loading') }}</p>
      <template v-else-if="projects.loaded">
        <ul class="overview__grid">
          <li v-for="project in projects.myProjects" :key="project.id">
            <ProjectCard :project="project" />
          </li>
        </ul>
        <EmptyState v-if="projects.teamProjects.length === 0" :title="t('overview.noTeamProjectsTitle')" :text="t('overview.noTeamProjects')">
          <AppButton v-if="!atLimit" variant="secondary" @click="creating = true">{{ t('nav.newProject') }}</AppButton>
        </EmptyState>
      </template>
    </section>

    <CreateProjectDialog v-model:open="creating" />
  </PageLayout>
</template>

<style scoped>
.overview__section {
  display: grid;
  gap: var(--space-3);
}
.overview__heading {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.overview__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.overview__grid > li {
  display: grid;
}
.overview__muted {
  margin: 0;
  color: var(--color-text-muted);
}
.overview__limit {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-warning);
}
</style>
