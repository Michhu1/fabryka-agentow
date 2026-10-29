<script setup lang="ts">
import type { PublicUser } from '@app/shared';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, apiClient } from '../../api/client';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import AppButton from '../ui/AppButton.vue';
import AppDialog from '../ui/AppDialog.vue';
import AppFormError from '../ui/AppFormError.vue';
import AppInput from '../ui/AppInput.vue';

/** Turning two-factor authentication off: confirmed with a code from the app or a recovery code. */
const emit = defineEmits<{ disabled: [] }>();
const open = defineModel<boolean>('open', { default: false });

const { t } = useI18n();
const auth = useAuthStore();
const errorText = useServerError();

const useRecovery = ref(false);
const code = ref('');
const error = ref<string | null>(null);
const sending = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  useRecovery.value = false;
  code.value = '';
  error.value = null;
});

function toggleRecovery() {
  useRecovery.value = !useRecovery.value;
  code.value = '';
  error.value = null;
}

async function submit() {
  error.value = null;
  const value = code.value.trim();
  if (!value) {
    error.value = t(useRecovery.value ? 'errors.mfaRequired' : 'errors.mfaCodeRequired');
    return;
  }
  sending.value = true;
  try {
    const body = useRecovery.value ? { mfaRecoveryCode: value } : { mfaCode: value.replace(/\s/g, '') };
    auth.setUser(await apiClient.post<PublicUser>('/rest/mfa/disable', body));
    emit('disabled');
    open.value = false;
  } catch (caught) {
    if (caught instanceof ApiError && caught.message === 'Two-factor authentication is not enabled') {
      // Turned off elsewhere meanwhile: re-read the user (the page then shows "Wyłączona") and close.
      await auth.refresh().catch(() => undefined);
      emit('disabled');
      open.value = false;
    } else error.value = errorText(caught);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <AppDialog
    v-model:open="open"
    :title="t('settings.personal.mfaDisable.title')"
    :description="t('settings.personal.mfaDisable.description')"
  >
    <form class="mfa-disable" novalidate data-test="mfa-disable-form" @submit.prevent="submit">
      <AppInput
        v-if="useRecovery"
        :key="'recovery'"
        v-model="code"
        :label="t('auth.mfa.recoveryLabel')"
        autocomplete="off"
        :maxlength="64"
        autofocus
        required
        data-test="mfa-disable-code"
      />
      <AppInput
        v-else
        :key="'app'"
        v-model="code"
        :label="t('auth.mfa.codeLabel')"
        inputmode="numeric"
        autocomplete="one-time-code"
        :maxlength="7"
        autofocus
        required
        data-test="mfa-disable-code"
      />
      <AppButton variant="link" data-test="mfa-disable-toggle" @click="toggleRecovery">
        {{ useRecovery ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery') }}
      </AppButton>
      <AppFormError :message="error" />
      <div class="mfa-disable__actions">
        <AppButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</AppButton>
        <AppButton type="submit" variant="danger" :loading="sending" data-test="mfa-disable-submit">
          {{ t('settings.personal.mfaDisable.submit') }}
        </AppButton>
      </div>
    </form>
  </AppDialog>
</template>

<style scoped>
.mfa-disable {
  display: grid;
  justify-items: stretch;
  gap: var(--space-3);
}
.mfa-disable > .app-button--link {
  justify-self: start;
}
.mfa-disable__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
