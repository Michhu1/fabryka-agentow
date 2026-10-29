<script setup lang="ts">
import { MFA_REQUIRED_CODE } from '@app/shared';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ApiError } from '../../api/client';
import AppButton from '../../components/ui/AppButton.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import AppInput from '../../components/ui/AppInput.vue';
import { useServerError } from '../../i18n/server-errors';
import AuthLayout from '../../layouts/AuthLayout.vue';
import { safeRedirect } from '../../router';
import { useAuthStore } from '../../stores/auth';
import { authLinkQuery, isProjectLinkRedirect, queryString } from './link-query';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const errorText = useServerError();

// `?email=` with a way back to an invitation or transfer page: that account is the one to sign in
// with, so the address is locked. Any other `?email=` only fills the field in.
const prefilledEmail = queryString(route.query.email);
const lockedEmail =
  prefilledEmail && isProjectLinkRedirect(router, route.query.redirect) ? prefilledEmail : null;
const email = ref(prefilledEmail ?? '');
const password = ref('');
const step = ref<'credentials' | 'mfa'>('credentials');
const useRecoveryCode = ref(false);
const mfaCode = ref('');
const recoveryCode = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);

const signupLink = computed(() => ({ name: 'signup', query: authLinkQuery(route.query) }));
const forgotLink = computed(() => ({
  name: 'forgot-password',
  query: email.value.trim() ? { email: email.value.trim() } : {},
}));

async function submit() {
  error.value = null;
  submitting.value = true;
  try {
    const mfa =
      step.value === 'mfa'
        ? useRecoveryCode.value
          ? { mfaRecoveryCode: recoveryCode.value.trim() }
          : { mfaCode: mfaCode.value.trim() }
        : {};
    await auth.login(email.value, password.value, mfa);
    await router.replace(safeRedirect(route.query.redirect) ?? '/home');
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === MFA_REQUIRED_CODE && step.value === 'credentials') {
      step.value = 'mfa';
    } else {
      error.value = errorText(caught);
    }
  } finally {
    submitting.value = false;
  }
}

function toggleRecoveryCode() {
  useRecoveryCode.value = !useRecoveryCode.value;
  error.value = null;
}

function backToCredentials() {
  step.value = 'credentials';
  mfaCode.value = '';
  recoveryCode.value = '';
  useRecoveryCode.value = false;
  error.value = null;
}
</script>

<template>
  <AuthLayout
    :title="step === 'mfa' ? t('auth.mfa.title') : t('auth.signin.title')"
    :subtitle="
      step === 'mfa'
        ? useRecoveryCode
          ? t('auth.mfa.recoveryDescription')
          : t('auth.mfa.appDescription')
        : t('auth.signin.subtitle')
    "
  >
    <form class="auth-form" novalidate @submit.prevent="submit">
      <AppFormError :message="error" />
      <template v-if="step === 'credentials'">
        <AppInput
          v-model="email"
          :label="t('common.email')"
          name="email"
          type="email"
          autocomplete="email"
          :readonly="!!lockedEmail"
          required
          :autofocus="!prefilledEmail"
          data-test="signin-email"
        />
        <AppInput
          v-model="password"
          :label="t('common.password')"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          :autofocus="!!prefilledEmail"
        />
        <RouterLink class="auth-form__aside" :to="forgotLink">{{ t('auth.signin.forgotPassword') }}</RouterLink>
        <AppButton type="submit" block :loading="submitting">{{ t('auth.signin.submit') }}</AppButton>
      </template>
      <template v-else>
        <AppInput
          v-if="!useRecoveryCode"
          v-model="mfaCode"
          :label="t('auth.mfa.codeLabel')"
          name="mfaCode"
          autocomplete="one-time-code"
          inputmode="numeric"
          :maxlength="6"
          required
          autofocus
        />
        <AppInput
          v-else
          v-model="recoveryCode"
          :label="t('auth.mfa.recoveryLabel')"
          name="recoveryCode"
          autocomplete="off"
          required
          autofocus
        />
        <AppButton variant="link" class="auth-form__aside" @click="toggleRecoveryCode">
          {{ useRecoveryCode ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery') }}
        </AppButton>
        <AppButton type="submit" block :loading="submitting">{{ t('auth.mfa.submit') }}</AppButton>
        <AppButton variant="ghost" block @click="backToCredentials">{{ t('common.back') }}</AppButton>
      </template>
    </form>
    <template #footer>
      {{ t('auth.signin.noAccount') }}
      <RouterLink :to="signupLink">{{ t('auth.signin.signupLink') }}</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped src="./auth-form.css"></style>
