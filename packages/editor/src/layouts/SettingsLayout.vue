<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, RouterView } from 'vue-router';
import { useAuthStore } from '../stores/auth';

/**
 * Settings pages (like n8n's): their own menu on the left — Osobiste, Użytkownicy (platform owner and
 * admins only), Klucze API — with a way back to the app.
 */
const { t } = useI18n();
const auth = useAuthStore();
const managesUsers = computed(() => auth.user?.role === 'global:owner' || auth.user?.role === 'global:admin');
</script>

<template>
  <div class="settings-layout">
    <nav class="settings-nav" :aria-label="t('settings.nav.label')">
      <RouterLink :to="{ name: 'home' }" class="settings-nav__back" data-test="settings-back">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ t('settings.nav.back') }}
      </RouterLink>
      <p class="settings-nav__title">{{ t('settings.title') }}</p>
      <ul class="settings-nav__list">
        <li>
          <RouterLink :to="{ name: 'settings-personal' }" class="settings-nav__link">{{ t('settings.nav.personal') }}</RouterLink>
        </li>
        <li v-if="managesUsers">
          <RouterLink :to="{ name: 'settings-users' }" class="settings-nav__link" data-test="nav-users">
            {{ t('settings.nav.users') }}
          </RouterLink>
        </li>
        <li>
          <RouterLink :to="{ name: 'settings-api' }" class="settings-nav__link">{{ t('settings.nav.api') }}</RouterLink>
        </li>
      </ul>
    </nav>
    <main class="settings-layout__content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.settings-layout {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  height: 100vh;
}
.settings-layout__content {
  min-width: 0;
  overflow-y: auto;
}
.settings-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  padding: var(--space-4) var(--space-3);
  overflow-y: auto;
  background: var(--color-sidebar);
  border-right: var(--border-width) solid var(--color-border);
}
.settings-nav__back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.settings-nav__back:hover {
  background: var(--color-nav-hover);
  color: var(--color-text);
  text-decoration: none;
}
.settings-nav__title {
  margin: 0;
  padding: 0 var(--space-2);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.settings-nav__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.settings-nav__link {
  display: flex;
  align-items: center;
  min-height: var(--icon-size-md);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  color: var(--color-text);
}
.settings-nav__link:hover {
  background: var(--color-nav-hover);
  text-decoration: none;
}
.settings-nav__link.router-link-active {
  background: var(--color-nav-active);
  color: var(--color-nav-active-text);
  font-weight: var(--font-weight-medium);
}
@media (max-width: 720px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: auto;
    min-height: 100vh;
  }
  .settings-nav {
    border-right: none;
    border-bottom: var(--border-width) solid var(--color-border);
  }
}
</style>
