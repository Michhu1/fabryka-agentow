<script setup lang="ts">
import type { MfaSetup, PublicUser } from '@app/shared';
import QRCode from 'qrcode';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, apiClient } from '../../api/client';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import { copyText, downloadText } from '../../utils/clipboard';
import AppAlert from '../ui/AppAlert.vue';
import AppButton from '../ui/AppButton.vue';
import AppDialog from '../ui/AppDialog.vue';
import AppFormError from '../ui/AppFormError.vue';
import AppInput from '../ui/AppInput.vue';

/**
 * Turning on two-factor authentication, in three steps: (1) scan the QR code (or type the secret) in an
 * authenticator app, (2) save the recovery codes (download or copy — "Dalej" waits for that), (3) prove
 * the app works with a 6-digit code. Every opening asks the server for a fresh secret; 2FA stays off
 * until step 3 succeeds.
 */
const emit = defineEmits<{ enabled: [] }>();
const open = defineModel<boolean>('open', { default: false });

const { t } = useI18n();
const auth = useAuthStore();
const errorText = useServerError();

/**
 * The QR code is always black on white: authenticator apps scan that reliably in every theme (the
 * frame around it is the `--color-qr-frame` token).
 */
const QR_COLORS = { dark: '#000000', light: '#ffffff' };

type Step = 'loading' | 'error' | 'qr' | 'codes' | 'confirm';
const step = ref<Step>('loading');
const setup = ref<MfaSetup | null>(null);
const qrSrc = ref('');
const codesSaved = ref(false);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
const code = ref('');
const error = ref<string | null>(null);
const enabling = ref(false);
/** Ignores the answer of a setup request made for an earlier opening. */
let attempt = 0;

const STEP_NUMBER: Partial<Record<Step, number>> = { qr: 1, codes: 2, confirm: 3 };
const stepNumber = computed(() => STEP_NUMBER[step.value] ?? 1);
const codeValid = computed(() => /^\d{6}$/.test(code.value.trim()));

/**
 * 2FA was turned on elsewhere (another tab or device) since the user was read: re-read the user, so the
 * page shows "Włączona", and close — there is nothing left to set up.
 */
async function alreadyEnabled(caught: unknown): Promise<boolean> {
  if (!(caught instanceof ApiError && caught.message === 'Two-factor authentication is already enabled')) {
    return false;
  }
  await auth.refresh().catch(() => undefined);
  emit('enabled');
  open.value = false;
  return true;
}

async function start() {
  const current = ++attempt;
  step.value = 'loading';
  setup.value = null;
  qrSrc.value = '';
  codesSaved.value = false;
  copyState.value = 'idle';
  code.value = '';
  error.value = null;
  try {
    const result = await apiClient.post<MfaSetup>('/rest/mfa/setup');
    const svg = await QRCode.toString(result.otpauthUrl, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: QR_COLORS,
    });
    if (current !== attempt) return;
    setup.value = result;
    qrSrc.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    step.value = 'qr';
  } catch (caught) {
    if (current !== attempt) return;
    if (await alreadyEnabled(caught)) return;
    error.value = errorText(caught);
    step.value = 'error';
  }
}

watch(
  open,
  (isOpen) => {
    if (isOpen) void start();
    else {
      // Closed: forget the secret and the codes (a new opening gets new ones).
      attempt++;
      setup.value = null;
      qrSrc.value = '';
    }
  },
  { immediate: true },
);

const codesText = computed(() => setup.value?.recoveryCodes.join('\n') ?? '');

function download() {
  if (!setup.value || !auth.user) return;
  const header = t('mfaSetup.fileHeader', { email: auth.user.email });
  downloadText(t('mfaSetup.fileName'), `${header}\n\n${codesText.value}\n`);
  codesSaved.value = true;
}

async function copy() {
  const ok = await copyText(codesText.value);
  copyState.value = ok ? 'copied' : 'failed';
  if (ok) codesSaved.value = true;
}

function onCodeInput(value: string) {
  // Authenticator apps show "123 456": spaces are fine, anything but digits is not a code.
  code.value = value.replace(/\s/g, '');
}

async function enable() {
  if (!codeValid.value) return;
  error.value = null;
  enabling.value = true;
  try {
    const user = await apiClient.post<PublicUser>('/rest/mfa/enable', { mfaCode: code.value.trim() });
    auth.setUser(user);
    emit('enabled');
    open.value = false;
  } catch (caught) {
    if (!(await alreadyEnabled(caught))) error.value = errorText(caught);
  } finally {
    enabling.value = false;
  }
}
</script>

<template>
  <AppDialog
    v-model:open="open"
    :title="t('mfaSetup.title')"
    :description="t('mfaSetup.description')"
    :dismissible="step !== 'codes' && step !== 'confirm'"
  >
    <p v-if="step === 'loading'" class="mfa__muted">{{ t('common.loading') }}</p>

    <template v-else-if="step === 'error'">
      <AppFormError :message="error" />
      <div class="mfa__actions">
        <AppButton variant="secondary" @click="open = false">{{ t('common.close') }}</AppButton>
        <AppButton @click="start">{{ t('common.retry') }}</AppButton>
      </div>
    </template>

    <template v-else-if="setup">
      <p class="mfa__step">{{ t('mfaSetup.step', { step: stepNumber }) }}</p>

      <section v-if="step === 'qr'" class="mfa__section" aria-labelledby="mfa-qr-title">
        <h3 id="mfa-qr-title" class="mfa__title">{{ t('mfaSetup.qrTitle') }}</h3>
        <p class="mfa__text">{{ t('mfaSetup.qrText') }}</p>
        <div class="mfa__qr-frame">
          <img class="mfa__qr" :src="qrSrc" :alt="t('mfaSetup.qrAlt')" width="200" height="200" data-test="mfa-qr" />
        </div>
        <p class="mfa__text">{{ t('mfaSetup.manual') }}</p>
        <code class="mfa__secret" data-test="mfa-secret">{{ setup.secret }}</code>
        <div class="mfa__actions">
          <AppButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</AppButton>
          <AppButton data-test="mfa-next" @click="step = 'codes'">{{ t('mfaSetup.next') }}</AppButton>
        </div>
      </section>

      <section v-else-if="step === 'codes'" class="mfa__section" aria-labelledby="mfa-codes-title">
        <h3 id="mfa-codes-title" class="mfa__title">{{ t('mfaSetup.codesTitle') }}</h3>
        <p class="mfa__text">{{ t('mfaSetup.codesText') }}</p>
        <ul class="mfa__codes" data-test="mfa-codes">
          <li v-for="item in setup.recoveryCodes" :key="item">{{ item }}</li>
        </ul>
        <div class="mfa__row">
          <AppButton variant="secondary" data-test="mfa-download" @click="download">{{ t('mfaSetup.download') }}</AppButton>
          <AppButton variant="secondary" data-test="mfa-copy" @click="copy">{{ t('mfaSetup.copy') }}</AppButton>
          <span v-if="copyState === 'copied'" class="mfa__ok" role="status">{{ t('mfaSetup.copied') }}</span>
        </div>
        <AppAlert v-if="copyState === 'failed'" variant="warning">{{ t('mfaSetup.copyFailed') }}</AppAlert>
        <p v-if="!codesSaved" class="mfa__muted">{{ t('mfaSetup.saveFirst') }}</p>
        <div class="mfa__actions">
          <AppButton variant="secondary" @click="step = 'qr'">{{ t('mfaSetup.back') }}</AppButton>
          <AppButton :disabled="!codesSaved" data-test="mfa-next" @click="step = 'confirm'">{{ t('mfaSetup.next') }}</AppButton>
        </div>
      </section>

      <form v-else class="mfa__section" novalidate aria-labelledby="mfa-confirm-title" @submit.prevent="enable">
        <h3 id="mfa-confirm-title" class="mfa__title">{{ t('mfaSetup.confirmTitle') }}</h3>
        <p class="mfa__text">{{ t('mfaSetup.confirmText') }}</p>
        <AppInput
          :model-value="code"
          :label="t('mfaSetup.code')"
          inputmode="numeric"
          autocomplete="one-time-code"
          :maxlength="7"
          autofocus
          required
          data-test="mfa-code"
          @update:model-value="onCodeInput"
        />
        <AppFormError :message="error" />
        <div class="mfa__actions">
          <AppButton variant="secondary" @click="step = 'codes'">{{ t('mfaSetup.back') }}</AppButton>
          <AppButton type="submit" :disabled="!codeValid" :loading="enabling" data-test="mfa-enable">
            {{ t('mfaSetup.enable') }}
          </AppButton>
        </div>
      </form>
    </template>
  </AppDialog>
</template>

<style scoped>
/* Scoped styles also reach this component's content teleported into the dialog. */
.mfa__section {
  display: grid;
  gap: var(--space-3);
}
.mfa__step {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mfa__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}
.mfa__text,
.mfa__muted {
  margin: 0;
}
.mfa__muted {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.mfa__qr-frame {
  justify-self: center;
  padding: var(--space-2);
  background: var(--color-qr-frame);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
}
.mfa__qr {
  display: block;
  width: 200px;
  height: 200px;
}
.mfa__secret {
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-muted);
  border-radius: var(--radius-md);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
  user-select: all;
}
.mfa__codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1) var(--space-4);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  list-style: none;
  background: var(--color-surface-muted);
  border-radius: var(--radius-md);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-md);
}
.mfa__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.mfa__ok {
  font-size: var(--font-size-sm);
  color: var(--color-success);
}
.mfa__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
