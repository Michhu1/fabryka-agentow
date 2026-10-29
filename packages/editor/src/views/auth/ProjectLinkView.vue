<script setup lang="ts">
import type { ProjectInvitationInfo, ProjectSummary, ProjectTransferInfo } from '@app/shared';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ApiError, apiClient } from '../../api/client';
import AppAlert from '../../components/ui/AppAlert.vue';
import AppButton from '../../components/ui/AppButton.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import { projectRoleKey } from '../../i18n';
import { useServerError } from '../../i18n/server-errors';
import AuthLayout from '../../layouts/AuthLayout.vue';
import { useAuthStore } from '../../stores/auth';
import { queryString } from './link-query';

/**
 * The page of a mailed project link: an invitation to a team project, or the transfer of one. Shows
 * what the link is for; a signed-out visitor signs in or signs up with the link's address (and comes
 * back here), a visitor signed in with another address is told to switch accounts, and the right
 * account accepts with "Akceptuj".
 */
const props = defineProps<{ kind: 'invitation' | 'transfer' }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const errorText = useServerError();

const api = computed(() =>
  props.kind === 'invitation'
    ? { base: '/rest/project-invitations', invalid: 'Invalid invitation token' }
    : { base: '/rest/project-transfers', invalid: 'Invalid transfer token' },
);

const token = queryString(route.query.token);
const state = ref<'loading' | 'ready' | 'invalid' | 'error'>('loading');
const info = ref<ProjectInvitationInfo | ProjectTransferInfo | null>(null);
const error = ref<string | null>(null);
const accepting = ref(false);
/** After a 409 "already a member": where "Przejdź do projektu" leads (the link is used up). */
const memberOf = ref<{ to: string } | null>(null);
const loggingOut = ref(false);

const invitation = computed(() =>
  props.kind === 'invitation' ? (info.value as ProjectInvitationInfo | null) : null,
);
const transfer = computed(() =>
  props.kind === 'transfer' ? (info.value as ProjectTransferInfo | null) : null,
);

const title = computed(() =>
  props.kind === 'invitation' ? t('auth.projectInvite.title') : t('auth.projectTransfer.title'),
);
const invalidText = computed(() =>
  props.kind === 'invitation' ? t('auth.projectInvite.invalid') : t('auth.projectTransfer.invalid'),
);

/** Emails are stored normalized; compare the same way. */
const sameAccount = computed(
  () => !!auth.user && !!info.value && auth.user.email.trim().toLowerCase() === info.value.email,
);

/** Sign-in / sign-up with the link's address, coming back to this page afterwards. */
const accountLink = computed(() => {
  if (!info.value || !token) return null;
  const query: Record<string, string> = { email: info.value.email, redirect: route.fullPath };
  if (info.value.hasAccount) return { name: 'signin', query };
  return { name: 'signup', query: { ...query, inviteToken: token } };
});

function isInvalidToken(caught: unknown): boolean {
  return caught instanceof ApiError && caught.message === api.value.invalid;
}

onMounted(async () => {
  if (!token) {
    state.value = 'invalid';
    return;
  }
  try {
    info.value = await apiClient.get<ProjectInvitationInfo | ProjectTransferInfo>(
      `${api.value.base}/resolve`,
      {
        token,
      },
    );
    state.value = 'ready';
  } catch (caught) {
    state.value = isInvalidToken(caught) ? 'invalid' : 'error';
    if (state.value === 'error') error.value = errorText(caught);
  }
});

function acceptErrorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.message === 'Team project limit reached') {
      return t('auth.projectTransfer.limitReached', { limit: auth.user?.teamProjectsLimit ?? '' });
    }
  }
  return errorText(caught);
}

async function accept() {
  error.value = null;
  accepting.value = true;
  try {
    const project = await apiClient.post<ProjectSummary>(`${api.value.base}/accept`, { token });
    // A transfer changes how many projects the user owns (the sidebar counter reads it).
    if (props.kind === 'transfer') await auth.refresh().catch(() => undefined);
    await router.replace(`/projects/${project.id}`);
  } catch (caught) {
    if (isInvalidToken(caught)) state.value = 'invalid';
    else if (caught instanceof ApiError && caught.message === 'User is already a member') {
      const id = caught.body.projectId;
      memberOf.value = { to: typeof id === 'string' ? `/projects/${encodeURIComponent(id)}` : '/home' };
    } else error.value = acceptErrorText(caught);
  } finally {
    accepting.value = false;
  }
}

async function logout() {
  loggingOut.value = true;
  await auth.logout();
  loggingOut.value = false;
}
</script>

<template>
  <AuthLayout :title="title">
    <p v-if="state === 'loading'" class="auth-form__muted">{{ t('common.loading') }}</p>
    <div v-else-if="state === 'invalid'" class="auth-form">
      <AppAlert variant="warning">{{ invalidText }}</AppAlert>
      <RouterLink v-if="auth.user" :to="{ name: 'home' }">{{ t('common.goHome') }}</RouterLink>
      <RouterLink v-else :to="{ name: 'signin' }" data-test="signin-link">{{ t('auth.projectLink.signin') }}</RouterLink>
    </div>
    <AppFormError v-else-if="state === 'error'" :message="error" />
    <div v-else-if="info" class="auth-form">
      <div class="project-link__summary">
        <template v-if="invitation">
          <p class="auth-form__text">
            {{
              invitation.inviterName
                ? t('auth.projectInvite.byInviter', { inviter: invitation.inviterName, project: invitation.projectName })
                : t('auth.projectInvite.anonymous', { project: invitation.projectName })
            }}
          </p>
          <p class="auth-form__muted">
            {{ t('auth.projectInvite.role', { role: t(projectRoleKey(invitation.role)) }) }}
          </p>
        </template>
        <template v-else-if="transfer">
          <p class="auth-form__text">
            {{ t('auth.projectTransfer.byOwner', { from: transfer.fromName, project: transfer.projectName }) }}
          </p>
          <p class="auth-form__muted">{{ t('auth.projectTransfer.effect', { from: transfer.fromName }) }}</p>
        </template>
      </div>

      <AppFormError :message="error" />

      <template v-if="!auth.user && info.pendingInvite">
        <AppAlert variant="info" data-test="pending-invite">{{ t('auth.projectLink.pendingInvite') }}</AppAlert>
      </template>
      <template v-else-if="!auth.user">
        <p class="auth-form__muted">
          {{ t('auth.projectLink.forEmail', { email: info.email }) }}
          {{ info.hasAccount ? t('auth.projectLink.signinToAccept') : t('auth.projectLink.signupToAccept') }}
        </p>
        <AppButton v-if="accountLink" :to="accountLink" block data-test="account-link">
          {{ info.hasAccount ? t('auth.projectLink.signin') : t('auth.projectLink.signup') }}
        </AppButton>
      </template>
      <template v-else-if="!sameAccount">
        <AppAlert variant="warning">
          {{ t('auth.projectLink.signedInAsOther', { current: auth.user.email, email: info.email }) }}
        </AppAlert>
        <AppButton variant="secondary" block :loading="loggingOut" @click="logout">
          {{ t('common.logout') }}
        </AppButton>
      </template>
      <template v-else-if="memberOf">
        <AppAlert variant="info">{{ t('auth.projectInvite.alreadyMember') }}</AppAlert>
        <AppButton :to="memberOf.to" block data-test="open-project">{{ t('auth.projectLink.openProject') }}</AppButton>
      </template>
      <AppButton v-else block :loading="accepting" @click="accept">{{ t('auth.projectLink.accept') }}</AppButton>
    </div>
  </AuthLayout>
</template>

<style scoped src="./auth-form.css"></style>
<style scoped>
.project-link__summary {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4);
  background: var(--color-surface-muted);
  border-radius: var(--radius-md);
}
</style>
