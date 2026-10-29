<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';
import CreateProjectDialog from '../projects/CreateProjectDialog.vue';
import ProjectIconView from '../projects/ProjectIconView.vue';
import ServerStatus from '../ServerStatus.vue';
import UserMenu from './UserMenu.vue';

/**
 * The app's left panel (like n8n's): Overview, the personal space, team projects with "+" (new
 * project) and the "Projekty: X z Y" counter of owned projects, and at the bottom the account menu and
 * the server status.
 */
const { t } = useI18n();
const auth = useAuthStore();
const projects = useProjectsStore();
const creating = ref(false);
const limitId = useId();
const route = useRoute();

/** A project stays highlighted on all its pages (its settings are a separate route, not a child). */
const isCurrent = (projectId: string) => route.params.projectId === projectId;

const owned = computed(() => auth.user?.ownedTeamProjects ?? 0);
const limit = computed(() => auth.user?.teamProjectsLimit ?? 0);
const atLimit = computed(() => auth.atTeamProjectLimit);

onMounted(() => {
  // A failure shows as an empty list here; the overview explains it.
  projects.ensureLoaded().catch(() => undefined);
});
</script>

<template>
  <nav class="sidebar" :aria-label="t('nav.mainMenu')">
    <p class="sidebar__brand">{{ t('common.appName') }}</p>

    <ul class="sidebar__list">
      <li>
        <RouterLink :to="{ name: 'home' }" class="sidebar__link">
          <svg class="sidebar__glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
          <span class="sidebar__text">{{ t('nav.overview') }}</span>
        </RouterLink>
      </li>
      <li v-if="auth.user">
        <RouterLink
          :to="`/projects/${auth.user.personalProjectId}`"
          class="sidebar__link"
          :class="{ 'sidebar__link--current': isCurrent(auth.user.personalProjectId) }"
        >
          <ProjectIconView
            class="sidebar__glyph"
            :project="{ type: 'personal', icon: projects.personalProject?.icon ?? null }"
          />
          <span class="sidebar__text">{{ t('nav.personal') }}</span>
        </RouterLink>
      </li>
    </ul>

    <section class="sidebar__section" aria-labelledby="sidebar-projects">
      <div class="sidebar__section-header">
        <h2 id="sidebar-projects" class="sidebar__section-title">{{ t('nav.projects') }}</h2>
        <button
          type="button"
          class="sidebar__add"
          :disabled="atLimit"
          :aria-label="t('nav.newProject')"
          :title="atLimit ? t('nav.limitReached') : t('nav.newProject')"
          :aria-describedby="atLimit ? limitId : undefined"
          data-test="new-project"
          @click="creating = true"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <ul class="sidebar__list">
        <li v-for="project in projects.teamProjects" :key="project.id">
          <RouterLink
            :to="`/projects/${project.id}`"
            class="sidebar__link"
            :class="{ 'sidebar__link--current': isCurrent(project.id) }"
          >
            <ProjectIconView class="sidebar__glyph" :project="project" />
            <span class="sidebar__text">{{ project.name }}</span>
          </RouterLink>
        </li>
      </ul>
      <p class="sidebar__counter" :title="t('nav.projectsCounterHint')" data-test="projects-counter">
        {{ t('nav.projectsCounter', { owned, limit }) }}
      </p>
      <p v-if="atLimit" :id="limitId" class="sidebar__limit" data-test="projects-limit">
        {{ t('nav.limitReached') }}
      </p>
    </section>

    <footer class="sidebar__footer">
      <UserMenu />
      <ServerStatus class="sidebar__status" />
    </footer>

    <CreateProjectDialog v-model:open="creating" />
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  height: 100%;
  padding: var(--space-4) var(--space-3);
  overflow-y: auto;
  background: var(--color-sidebar);
  border-right: var(--border-width) solid var(--color-border);
}
.sidebar__brand {
  margin: 0;
  padding: 0 var(--space-2);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.sidebar__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sidebar__link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--icon-size-md);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-md);
}
.sidebar__link:hover {
  background: var(--color-nav-hover);
  text-decoration: none;
}
.sidebar__link.router-link-active,
.sidebar__link--current {
  background: var(--color-nav-active);
  color: var(--color-nav-active-text);
  font-weight: var(--font-weight-medium);
}
.sidebar__glyph {
  flex: none;
  width: var(--icon-size-sm);
  height: var(--icon-size-sm);
  padding: 2px;
  color: currentColor;
}
.sidebar__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar__section {
  display: grid;
  gap: var(--space-1);
}
.sidebar__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: var(--space-2);
}
.sidebar__section-title {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sidebar__add {
  display: inline-grid;
  place-items: center;
  width: var(--icon-size-sm);
  height: var(--icon-size-sm);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.sidebar__add:hover:not(:disabled) {
  background: var(--color-nav-hover);
  color: var(--color-text);
}
.sidebar__add:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}
.sidebar__counter,
.sidebar__limit {
  margin: 0;
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.sidebar__limit {
  color: var(--color-warning);
}
.sidebar__footer {
  display: grid;
  gap: var(--space-2);
  margin-top: auto;
  padding-top: var(--space-3);
  border-top: var(--border-width) solid var(--color-border);
}
.sidebar__status {
  padding: 0 var(--space-2);
}
</style>
