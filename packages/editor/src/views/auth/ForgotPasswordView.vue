<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';
import { apiClient } from '../../api/client';
import AppAlert from '../../components/ui/AppAlert.vue';
import AppButton from '../../components/ui/AppButton.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import AppInput from '../../components/ui/AppInput.vue';
import { useServerError } from '../../i18n/server-errors';
import AuthLayout from '../../layouts/AuthLayout.vue';
import { queryString } from './link-query';

const { t } = useI18n();
const route = useRoute();
const errorText = useServerError();

const email = ref(queryString(route.query.email) ?? '');
const sentTo = ref<string | null>(null);
const error = ref<string | null>(null);
const submitting = ref(false);

async function submit() {
  error.value = null;
  submitting.value = true;
  try {
    // The server answers the same whether or not the account exists, and so does this page.
    await apiClient.post('/rest/forgot-password', { email: email.value });
    sentTo.value = email.value.trim();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('auth.forgot.title')" :subtitle="sentTo ? undefined : t('auth.forgot.subtitle')">
    <AppAlert v-if="sentTo" variant="success">{{ t('auth.forgot.sent', { email: sentTo }) }}</AppAlert>
    <form v-else class="auth-form" novalidate @submit.prevent="submit">
      <AppFormError :message="error" />
      <AppInput
        v-model="email"
        :label="t('common.email')"
        type="email"
        name="email"
        autocomplete="email"
        required
        autofocus
      />
      <AppButton type="submit" block :loading="submitting">{{ t('auth.forgot.submit') }}</AppButton>
    </form>
    <template #footer>
      <RouterLink :to="{ name: 'signin' }">{{ t('auth.forgot.backToSignin') }}</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped src="./auth-form.css"></style>
