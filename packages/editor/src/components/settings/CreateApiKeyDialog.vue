<script setup lang="ts">
import type { ApiKeySummary, CreatedApiKey } from '@app/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiClient } from '../../api/client';
import { useServerError } from '../../i18n/server-errors';
import { copyText } from '../../utils/clipboard';
import AppAlert from '../ui/AppAlert.vue';
import AppButton from '../ui/AppButton.vue';
import AppDialog from '../ui/AppDialog.vue';
import AppFormError from '../ui/AppFormError.vue';
import AppInput from '../ui/AppInput.vue';
import AppSelect from '../ui/AppSelect.vue';

/**
 * "Utwórz klucz": a name and how long the key works. The created key is shown here once, with "Kopiuj"
 * and a warning — it is never stored in the editor and never shown again (the list has only its last
 * four characters). Closing the dialog forgets it.
 */
const emit = defineEmits<{ created: [key: ApiKeySummary] }>();
const open = defineModel<boolean>('open', { default: false });

const { t } = useI18n();
const errorText = useServerError();

type Expiry = '7' | '30' | '90' | '365' | 'never' | 'custom';
const DAY_MS = 24 * 60 * 60 * 1000;

const label = ref('');
const expiry = ref<Expiry>('30');
const customDate = ref('');
const error = ref<string | null>(null);
const creating = ref(false);
/** The created key (with the full key), only while this dialog stays open. */
const created = ref<CreatedApiKey | null>(null);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');

const expiryOptions = computed(() =>
  (
    [
      ['7', 'days7'],
      ['30', 'days30'],
      ['90', 'days90'],
      ['365', 'year'],
      ['never', 'never'],
      ['custom', 'custom'],
    ] as const
  ).map(([value, key]) => ({ value, label: t(`settings.createKey.expiryOptions.${key}`) })),
);

/** Tomorrow as `YYYY-MM-DD` in local time: the earliest day a custom expiry may be. */
const tomorrow = computed(() => {
  const date = new Date(Date.now() + DAY_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
});

watch(open, (isOpen) => {
  if (isOpen) {
    label.value = '';
    expiry.value = '30';
    customDate.value = '';
    error.value = null;
  }
  // Opening or closing: the key from last time is gone.
  created.value = null;
  copyState.value = 'idle';
});

/** The chosen expiry as an ISO timestamp; null = never; undefined = invalid custom date. */
function expiresAt(): string | null | undefined {
  if (expiry.value === 'never') return null;
  if (expiry.value === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate.value)) return undefined;
    // The key works through the whole chosen day (local time).
    const end = new Date(`${customDate.value}T23:59:59`);
    return Number.isNaN(end.getTime()) || end.getTime() <= Date.now() ? undefined : end.toISOString();
  }
  return new Date(Date.now() + Number(expiry.value) * DAY_MS).toISOString();
}

async function submit() {
  error.value = null;
  if (!label.value.trim()) {
    error.value = t('errors.labelRequired');
    return;
  }
  const expires = expiresAt();
  if (expires === undefined) {
    error.value = t('settings.createKey.invalidDate');
    return;
  }
  creating.value = true;
  try {
    const key = await apiClient.post<CreatedApiKey>('/rest/api-keys', {
      label: label.value.trim(),
      expiresAt: expires,
    });
    created.value = key;
    const { rawKey: _shownOnce, ...summary } = key;
    emit('created', summary);
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    creating.value = false;
  }
}

async function copy() {
  if (!created.value) return;
  copyState.value = (await copyText(created.value.rawKey)) ? 'copied' : 'failed';
}

function selectAll(event: FocusEvent) {
  (event.target as HTMLInputElement | null)?.select();
}
</script>

<template>
  <AppDialog
    v-model:open="open"
    :title="created ? t('settings.createKey.createdTitle', { label: created.label }) : t('settings.createKey.title')"
    :description="created ? t('settings.createKey.createdDescription') : t('settings.createKey.description')"
    :dismissible="!created"
  >
    <div v-if="created" class="create-key">
      <AppAlert variant="warning">{{ t('settings.createKey.warning') }}</AppAlert>
      <div class="create-key__raw">
        <label class="create-key__label" for="created-api-key">{{ t('settings.createKey.key') }}</label>
        <div class="create-key__row">
          <input
            id="created-api-key"
            class="create-key__value"
            :value="created.rawKey"
            readonly
            spellcheck="false"
            data-test="api-key-raw"
            @focus="selectAll"
          />
          <AppButton variant="secondary" data-test="api-key-copy" @click="copy">{{ t('settings.createKey.copy') }}</AppButton>
        </div>
        <span v-if="copyState === 'copied'" class="create-key__ok" role="status">{{ t('settings.createKey.copied') }}</span>
        <AppAlert v-else-if="copyState === 'failed'" variant="danger">{{ t('settings.createKey.copyFailed') }}</AppAlert>
      </div>
      <div class="create-key__actions">
        <AppButton data-test="api-key-done" @click="open = false">{{ t('settings.createKey.done') }}</AppButton>
      </div>
    </div>
    <form v-else class="create-key" novalidate data-test="api-key-form" @submit.prevent="submit">
      <AppInput
        v-model="label"
        :label="t('settings.createKey.label')"
        :maxlength="100"
        autocomplete="off"
        required
        autofocus
        data-test="api-key-label"
      />
      <AppSelect v-model="expiry" :label="t('settings.createKey.expiry')" :options="expiryOptions" data-test="api-key-expiry" />
      <AppInput
        v-if="expiry === 'custom'"
        v-model="customDate"
        type="date"
        :min="tomorrow"
        :label="t('settings.createKey.customDate')"
        required
        data-test="api-key-date"
      />
      <AppFormError :message="error" />
      <div class="create-key__actions">
        <AppButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</AppButton>
        <AppButton type="submit" :loading="creating" data-test="api-key-submit">{{ t('settings.createKey.submit') }}</AppButton>
      </div>
    </form>
  </AppDialog>
</template>

<style scoped>
/* Scoped styles also reach this component's content teleported into the dialog. */
.create-key {
  display: grid;
  gap: var(--space-4);
}
.create-key__raw {
  display: grid;
  gap: var(--space-1);
}
.create-key__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.create-key__row {
  display: flex;
  gap: var(--space-2);
}
.create-key__value {
  flex: 1;
  min-width: 0;
  min-height: var(--control-height);
  padding: 0 var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  color: var(--color-text);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
}
.create-key__value:focus {
  outline: none;
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}
.create-key__ok {
  font-size: var(--font-size-sm);
  color: var(--color-success);
}
.create-key__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
