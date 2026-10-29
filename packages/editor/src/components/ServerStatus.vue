<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSystemStore } from '../stores/system';

/** Server version and readiness (from M0), shown in the sidebar footer. */
const system = useSystemStore();
const { t } = useI18n();
onMounted(() => system.load());

const statusText = computed(() => {
  if (system.ready === null) return t('system.checking');
  return system.ready ? t('system.ready') : t('system.unavailable');
});
</script>

<template>
  <div class="server-status">
    <span class="server-status__version">{{ system.version ?? t('common.appName') }}</span>
    <span class="server-status__state" :data-ready="system.ready">{{ statusText }}</span>
  </div>
</template>

<style scoped>
.server-status {
  display: grid;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.server-status__state[data-ready='true'] {
  color: var(--color-success);
}
.server-status__state[data-ready='false'] {
  color: var(--color-danger);
}
</style>
