<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AppButton from '../../components/ui/AppButton.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import AppInput from '../../components/ui/AppInput.vue';
import { useServerError } from '../../i18n/server-errors';
import AuthLayout from '../../layouts/AuthLayout.vue';
import { safeRedirect } from '../../router';
import { useAuthStore } from '../../stores/auth';
import { meetsPasswordPolicy } from '../../utils/password';
import { authLinkQuery, queryString } from './link-query';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const errorText = useServerError();

// From a project invitation or transfer link: the account must use the address the link was sent to,
// and the token lets it sign up even when open signup is disabled.
const inviteToken = queryString(route.query.inviteToken);
const prefilledEmail = queryString(route.query.email);
const emailLocked = !!inviteToken && !!prefilledEmail;

const firstName = ref('');
const lastName = ref('');
const email = ref(prefilledEmail ?? '');
const password = ref('');
const passwordError = ref<string | undefined>();
const error = ref<string | null>(null);
const submitting = ref(false);

// Keeps the invitation's email, token and redirect, so going back and forth loses nothing.
const signinLink = computed(() => ({ name: 'signin', query: authLinkQuery(route.query) }));

async function submit() {
  error.value = null;
  passwordError.value = undefined;
  if (!meetsPasswordPolicy(password.value)) {
    passwordError.value = t('errors.passwordPolicy');
    return;
  }
  submitting.value = true;
  try {
    await auth.signup({
      email: email.value,
      firstName: firstName.value,
      lastName: lastName.value,
      password: password.value,
      ...(inviteToken ? { inviteToken } : {}),
    });
    await router.replace(safeRedirect(route.query.redirect) ?? '/home');
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('auth.signup.title')" :subtitle="t('auth.signup.subtitle')">
    <form class="auth-form" novalidate @submit.prevent="submit">
      <AppFormError :message="error" />
      <div class="auth-form__row">
        <AppInput
          v-model="firstName"
          :label="t('common.firstName')"
          name="firstName"
          autocomplete="given-name"
          :maxlength="32"
          required
          autofocus
        />
        <AppInput
          v-model="lastName"
          :label="t('common.lastName')"
          name="lastName"
          autocomplete="family-name"
          :maxlength="32"
          required
        />
      </div>
      <AppInput
        v-model="email"
        :label="t('common.email')"
        type="email"
        name="email"
        autocomplete="email"
        :readonly="emailLocked"
        :hint="emailLocked ? t('auth.signup.emailFromInvite') : undefined"
        required
      />
      <AppInput
        v-model="password"
        :label="t('common.password')"
        type="password"
        name="password"
        autocomplete="new-password"
        :hint="t('auth.passwordHint')"
        :error="passwordError"
        required
      />
      <AppButton type="submit" block :loading="submitting">{{ t('auth.signup.submit') }}</AppButton>
    </form>
    <template #footer>
      {{ t('auth.signup.haveAccount') }}
      <RouterLink :to="signinLink">{{ t('auth.signup.signinLink') }}</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped src="./auth-form.css"></style>
