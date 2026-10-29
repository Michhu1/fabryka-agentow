<script setup lang="ts">
import type { InvitationInfo, PublicUser } from '@app/shared';
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

/** An invitation to the platform (Settings → Users → Zaproś): the invited person sets name and password. */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const errorText = useServerError();

const token = queryString(route.query.token);
const state = ref<'loading' | 'ready' | 'invalid' | 'error'>('loading');
const invitation = ref<InvitationInfo | null>(null);
const firstName = ref('');
const lastName = ref('');
const password = ref('');
const passwordError = ref<string | undefined>();
const error = ref<string | null>(null);
const submitting = ref(false);

function isInvalidToken(caught: unknown): boolean {
  return caught instanceof ApiError && caught.message === 'Invalid invitation token';
}

onMounted(async () => {
  if (!token) {
    state.value = 'invalid';
    return;
  }
  try {
    invitation.value = await apiClient.get<InvitationInfo>('/rest/invitations/resolve', { token });
    state.value = 'ready';
  } catch (caught) {
    state.value = isInvalidToken(caught) ? 'invalid' : 'error';
    if (state.value === 'error') error.value = errorText(caught);
  }
});

async function submit() {
  error.value = null;
  passwordError.value = undefined;
  if (!meetsPasswordPolicy(password.value)) {
    passwordError.value = t('errors.passwordPolicy');
    return;
  }
  submitting.value = true;
  try {
    const user = await apiClient.post<PublicUser>('/rest/invitations/accept', {
      token,
      firstName: firstName.value,
      lastName: lastName.value,
      password: password.value,
    });
    auth.setUser(user);
    await router.replace('/home');
  } catch (caught) {
    if (isInvalidToken(caught)) state.value = 'invalid';
    else error.value = errorText(caught);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('auth.invite.title')">
    <p v-if="state === 'loading'" class="auth-form__muted">{{ t('common.loading') }}</p>
    <div v-else-if="state === 'invalid'" class="auth-form">
      <AppAlert variant="warning">{{ t('auth.invite.invalid') }}</AppAlert>
      <RouterLink v-if="auth.user" :to="{ name: 'home' }">{{ t('common.goHome') }}</RouterLink>
      <RouterLink v-else :to="{ name: 'signin' }" data-test="signin-link">{{ t('auth.signin.title') }}</RouterLink>
    </div>
    <AppFormError v-else-if="state === 'error'" :message="error" />
    <div v-else-if="auth.user" class="auth-form">
      <AppAlert variant="warning">{{ t('auth.invite.signedInAs', { email: auth.user.email }) }}</AppAlert>
      <AppButton variant="secondary" block @click="auth.logout()">{{ t('common.logout') }}</AppButton>
    </div>
    <form v-else-if="invitation" class="auth-form" novalidate @submit.prevent="submit">
      <p class="auth-form__text">
        {{
          invitation.inviterName
            ? t('auth.invite.byInviter', { inviter: invitation.inviterName })
            : t('auth.invite.anonymous')
        }}
        {{ t('auth.invite.forEmail', { email: invitation.email }) }}
      </p>
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
      <AppInput :model-value="invitation.email" :label="t('common.email')" name="email" type="email" autocomplete="email" readonly />
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
      <AppButton type="submit" block :loading="submitting">{{ t('auth.invite.submit') }}</AppButton>
    </form>
  </AuthLayout>
</template>

<style scoped src="./auth-form.css"></style>
