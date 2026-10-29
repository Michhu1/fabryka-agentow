<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppSidebar from '../components/sidebar/AppSidebar.vue';

/** The signed-in app: the sidebar and the current page. */
</script>

<template>
  <div class="main-layout">
    <AppSidebar class="main-layout__sidebar" />
    <main class="main-layout__content">
      <!-- Keyed by path: moving between projects starts the page afresh (loads the other project). -->
      <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="route.path" />
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.main-layout {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  height: 100vh;
}
.main-layout__sidebar {
  min-height: 0;
}
.main-layout__content {
  min-width: 0;
  overflow-y: auto;
}
@media (max-width: 720px) {
  .main-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: auto;
    min-height: 100vh;
  }
  .main-layout__sidebar {
    height: auto;
    border-right: none;
    border-bottom: var(--border-width) solid var(--color-border);
  }
}
</style>
