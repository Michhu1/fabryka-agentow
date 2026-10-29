<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import EmptyState from '../components/EmptyState.vue';
import PageLayout from '../components/PageLayout.vue';
import AppButton from '../components/ui/AppButton.vue';

/** An address the app does not know (inside the app layout). */
const { t } = useI18n();
</script>

<template>
  <PageLayout>
    <EmptyState :title="t('notFound.title')" :text="t('notFound.text')" :level="1">
      <AppButton :to="{ name: 'home' }" variant="secondary">{{ t('common.goHome') }}</AppButton>
    </EmptyState>
  </PageLayout>
</template>
