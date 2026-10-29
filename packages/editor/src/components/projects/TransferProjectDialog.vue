<script setup lang="ts">
import { MFA_REQUIRED_CODE, type ProjectTransferResult } from '@app/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api/client';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import { isProjectGone, useProjectsStore } from '../../stores/projects';
import AppAlert from '../ui/AppAlert.vue';
import AppButton from '../ui/AppButton.vue';
import AppDialog from '../ui/AppDialog.vue';
import AppFormError from '../ui/AppFormError.vue';
import AppInput from '../ui/AppInput.vue';

/**
 * "Przekaż projekt": the recipient's email, confirmed with the current password — or the 2FA code when
 * the account has 2FA on (the server then requires it instead of the password).
 */
const props = defineProps<{ projectId: string; projectName: string; hasPending: boolean }>();
const emit = defineEmits<{
  sent: [result: ProjectTransferResult];
  /** The project is gone (404) or the user's role changed (403): the page handles it, the dialog closes. */
  projectError: [error: ApiError];
}>();
const open = defineModel<boolean>('open', { default: false });

const { t } = useI18n();
const auth = useAuthStore();
const projects = useProjectsStore();
const errorText = useServerError();

const email = ref('');
const password = ref('');
const mfaCode = ref('');
const error = ref<string | null>(null);
const sending = ref(false);
/**
 * Which proof the form asks for. Starts from the user as last read; 2FA may have been turned on or off
 * elsewhere since, so the server's answer switches it: "MFA required" (998) → the code, "Current password
 * is required" → the password (and the user is re-read).
 */
const proof = ref<'password' | 'mfa'>('password');
const useMfa = computed(() => proof.value === 'mfa');

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    email.value = '';
    password.value = '';
    mfaCode.value = '';
    error.value = null;
    proof.value = auth.user?.mfaEnabled ? 'mfa' : 'password';
  },
  { immediate: true },
);

function switchProof(next: 'password' | 'mfa') {
  if (proof.value === next) return;
  proof.value = next;
  password.value = '';
  mfaCode.value = '';
  void auth.refresh().catch(() => undefined);
}

async function submit() {
  error.value = null;
  if (!email.value.trim()) {
    error.value = t('errors.emailRequired');
    return;
  }
  const confirmation = useMfa.value ? { mfaCode: mfaCode.value.trim() } : { currentPassword: password.value };
  sending.value = true;
  try {
    const result = await projects.requestTransfer(props.projectId, {
      email: email.value.trim(),
      ...confirmation,
    });
    emit('sent', result);
    open.value = false;
  } catch (caught) {
    if (caught instanceof ApiError && (isProjectGone(caught) || caught.status === 403)) {
      open.value = false;
      emit('projectError', caught);
      return;
    }
    if (caught instanceof ApiError && caught.code === MFA_REQUIRED_CODE) switchProof('mfa');
    else if (caught instanceof ApiError && caught.message === 'Current password is required') {
      switchProof('password');
    }
    error.value = errorText(caught);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <AppDialog
    v-model:open="open"
    :title="t('projects.transfer.dialogTitle', { name: projectName })"
    :description="t('projects.transfer.description')"
  >
    <form class="transfer" novalidate data-test="transfer-form" @submit.prevent="submit">
      <AppAlert v-if="hasPending" variant="warning">{{ t('projects.transfer.replaceNotice') }}</AppAlert>
      <AppInput
        v-model="email"
        type="email"
        autocomplete="off"
        :label="t('projects.transfer.email')"
        required
        autofocus
        data-test="transfer-email"
      />
      <AppInput
        v-if="useMfa"
        v-model="mfaCode"
        inputmode="numeric"
        autocomplete="one-time-code"
        :label="t('projects.transfer.mfaCode')"
        :hint="t('projects.transfer.mfaHint')"
        :maxlength="64"
        required
        data-test="transfer-mfa"
      />
      <AppInput
        v-else
        v-model="password"
        type="password"
        autocomplete="current-password"
        :label="t('projects.transfer.password')"
        :hint="t('projects.transfer.passwordHint')"
        required
        data-test="transfer-password"
      />
      <AppFormError :message="error" />
      <div class="transfer__actions">
        <AppButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</AppButton>
        <AppButton type="submit" :loading="sending">{{ t('projects.transfer.submit') }}</AppButton>
      </div>
    </form>
  </AppDialog>
</template>

<style scoped>
.transfer {
  display: grid;
  gap: var(--space-4);
}
.transfer__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
