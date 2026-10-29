<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AuthLayout from '../layouts/AuthLayout.vue';
import { useAuthStore } from '../stores/auth';
import AppButton from './ui/AppButton.vue';

/**
 * Shown instead of the app when the session could not be read at start (server unreachable or 5xx):
 * "not signed in" would be a guess. "Spróbuj ponownie" reads it again and, once the server answers,
 * re-runs the router guard on the current address (sign-in, or the page itself).
 */
const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const retrying = ref(false);

async function retry() {
  retrying.value = true;
  try {
    await auth.retry();
    if (!auth.offline) {
      const { path, query, hash } = router.currentRoute.value;
      await router.replace({ path, query, hash, force: true });
    }
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('offline.title')" :subtitle="t('offline.text')">
    <AppButton block :loading="retrying" data-test="retry" @click="retry">{{ t('common.retry') }}</AppButton>
  </AuthLayout>
</template>
