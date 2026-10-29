<script setup lang="ts">
import { MFA_REQUIRED_CODE, type PublicUser, type ResolvePasswordTokenResponse } from '@app/shared';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ApiError, apiClient } from '../../api/client';
import AppAlert from '../../components/ui/AppAlert.vue';
import AppButton from '../../components/ui/AppButton.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import AppInput from '../../components/ui/AppInput.vue';
import { useServerError } from '../../i18n/server-errors';
import AuthLayout from '../../layouts/AuthLayout.vue';
import { useAuthStore } from '../../stores/auth';
import { meetsPasswordPolicy } from '../../utils/password';
import { queryString } from './link-query';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const errorText = useServerError();

const token = queryString(route.query.token);
const state = ref<'loading' | 'ready' | 'invalid' | 'error'>('loading');
const mfaRequired = ref(false);
const password = ref('');
const confirm = ref('');
const mfaCode = ref('');
const passwordError = ref<string | undefined>();
const confirmError = ref<string | undefined>();
const error = ref<string | null>(null);
const submitting = ref(false);

function isInvalidToken(caught: unknown): boolean {
  return caught instanceof ApiError && caught.message === 'Invalid password reset token';
}

onMounted(async () => {
  if (!token) {
    state.value = 'invalid';
    return;
  }
  try {
    const resolved = await apiClient.get<ResolvePasswordTokenResponse>('/rest/resolve-password-token', {
      token,
    });
    mfaRequired.value = resolved.mfaRequired;
    state.value = 'ready';
  } catch (caught) {
    state.value = isInvalidToken(caught) ? 'invalid' : 'error';
    if (state.value === 'error') error.value = errorText(caught);
  }
});

async function submit() {
  error.value = null;
  passwordError.value = undefined;
  confirmError.value = undefined;
  if (!meetsPasswordPolicy(password.value)) {
    passwordError.value = t('errors.passwordPolicy');
    return;
  }
  if (password.value !== confirm.value) {
    confirmError.value = t('auth.passwordMismatch');
    return;
  }
  submitting.value = true;
  try {
    // The answer signs this device in (all older sessions end with the old password).
    const user = await apiClient.post<PublicUser>('/rest/change-password', {
      token,
      password: password.value,
      ...(mfaRequired.value ? { mfaCode: mfaCode.value.trim() } : {}),
    });
    auth.setUser(user);
    await router.replace('/home');
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === MFA_REQUIRED_CODE && !mfaRequired.value) {
      mfaRequired.value = true;
      error.value = t('errors.mfaRequired');
    } else if (isInvalidToken(caught)) {
      state.value = 'invalid';
    } else {
      error.value = errorText(caught);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthLayout
    :title="t('auth.reset.title')"
    :subtitle="state === 'ready' ? t('auth.reset.subtitle') : undefined"
  >
    <p v-if="state === 'loading'" class="auth-form__muted">{{ t('common.loading') }}</p>
    <div v-else-if="state === 'invalid'" class="auth-form">
      <AppAlert variant="warning">{{ t('auth.reset.invalid') }}</AppAlert>
      <RouterLink :to="{ name: 'forgot-password' }">{{ t('auth.reset.requestNew') }}</RouterLink>
    </div>
    <AppFormError v-else-if="state === 'error'" :message="error" />
    <form v-else class="auth-form" novalidate @submit.prevent="submit">
      <AppFormError :message="error" />
      <AppAlert v-if="mfaRequired" variant="info">{{ t('auth.reset.mfaNotice') }}</AppAlert>
      <AppInput
        v-model="password"
        :label="t('auth.reset.newPassword')"
        type="password"
        name="password"
        autocomplete="new-password"
        :hint="t('auth.passwordHint')"
        :error="passwordError"
        required
        autofocus
      />
      <AppInput
        v-model="confirm"
        :label="t('auth.reset.confirmPassword')"
        type="password"
        name="passwordConfirm"
        autocomplete="new-password"
        :error="confirmError"
        required
      />
      <AppInput
        v-if="mfaRequired"
        v-model="mfaCode"
        :label="t('auth.mfa.codeLabel')"
        name="mfaCode"
        autocomplete="one-time-code"
        inputmode="numeric"
        :maxlength="6"
        required
      />
      <AppButton type="submit" block :loading="submitting">{{ t('auth.reset.submit') }}</AppButton>
    </form>
    <template #footer>
      <RouterLink :to="{ name: 'signin' }">{{ t('auth.forgot.backToSignin') }}</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped src="./auth-form.css"></style>
