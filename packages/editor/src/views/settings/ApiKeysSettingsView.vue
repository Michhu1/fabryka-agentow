<script setup lang="ts">
import { API_KEYS_LIMIT, type ApiKeySummary } from '@app/shared';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, apiClient } from '../../api/client';
import EmptyState from '../../components/EmptyState.vue';
import PageLayout from '../../components/PageLayout.vue';
import CreateApiKeyDialog from '../../components/settings/CreateApiKeyDialog.vue';
import AppAlert from '../../components/ui/AppAlert.vue';
import AppButton from '../../components/ui/AppButton.vue';
import AppDialog from '../../components/ui/AppDialog.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import { useServerError } from '../../i18n/server-errors';
import { formatDate, formatDateTime } from '../../utils/dates';

/**
 * Settings → Klucze API (n8n: n8n API): the user's own keys for the public API. The list shows only
 * the last four characters of each key; the full key appears once, in the create dialog.
 */
const { t } = useI18n();
const errorText = useServerError();

const keys = ref<ApiKeySummary[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref<string | null>(null);
const createOpen = ref(false);
const atLimit = computed(() => keys.value.length >= API_KEYS_LIMIT);

async function load() {
  try {
    keys.value = await apiClient.get<ApiKeySummary[]>('/rest/api-keys');
    state.value = 'ready';
  } catch (caught) {
    error.value = errorText(caught);
    if (state.value === 'loading') state.value = 'error';
  }
}
onMounted(load);

function onCreated(key: ApiKeySummary) {
  keys.value = [key, ...keys.value.filter((item) => item.id !== key.id)];
}

const isExpired = (key: ApiKeySummary) => !!key.expiresAt && Date.parse(key.expiresAt) <= Date.now();

// --- Delete ----------------------------------------------------------------------------------------
const toDelete = ref<ApiKeySummary | null>(null);
const deleteOpen = computed({
  get: () => toDelete.value !== null,
  set: (open) => {
    if (!open) toDelete.value = null;
  },
});
const deleting = ref(false);
const deleteError = ref<string | null>(null);

function askDelete(key: ApiKeySummary) {
  deleteError.value = null;
  toDelete.value = key;
}

async function deleteKey() {
  const key = toDelete.value;
  if (!key) return;
  deleteError.value = null;
  deleting.value = true;
  try {
    await apiClient.delete(`/rest/api-keys/${key.id}`);
    keys.value = keys.value.filter((item) => item.id !== key.id);
    toDelete.value = null;
  } catch (caught) {
    // Already gone (deleted in another window): the list catches up.
    if (caught instanceof ApiError && caught.message === 'API key not found') {
      toDelete.value = null;
      await load();
    } else deleteError.value = errorText(caught);
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <PageLayout :title="t('settings.apiKeys.title')" :subtitle="t('settings.apiKeys.subtitle')">
    <template #actions>
      <AppButton :disabled="state !== 'ready' || atLimit" data-test="api-key-create" @click="createOpen = true">
        {{ t('settings.apiKeys.create') }}
      </AppButton>
    </template>

    <p v-if="state === 'loading'" class="keys__muted">{{ t('common.loading') }}</p>
    <AppFormError v-else-if="state === 'error'" :message="error" />
    <template v-else>
      <AppAlert v-if="atLimit" variant="info" data-test="api-key-limit">
        {{ t('settings.apiKeys.limit', { limit: API_KEYS_LIMIT }) }}
      </AppAlert>
      <EmptyState v-if="keys.length === 0" :title="t('settings.apiKeys.emptyTitle')" :text="t('settings.apiKeys.emptyText')" />
      <div v-else class="keys__wrap">
        <table class="keys" :aria-label="t('settings.apiKeys.listLabel')">
          <thead>
            <tr>
              <th scope="col">{{ t('settings.apiKeys.columns.label') }}</th>
              <th scope="col">{{ t('settings.apiKeys.columns.key') }}</th>
              <th scope="col">{{ t('settings.apiKeys.columns.created') }}</th>
              <th scope="col">{{ t('settings.apiKeys.columns.expires') }}</th>
              <th scope="col">{{ t('settings.apiKeys.columns.lastUsed') }}</th>
              <th scope="col"><span class="visually-hidden">{{ t('settings.apiKeys.columns.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in keys" :key="key.id" data-test="api-key-row">
              <td class="keys__label">{{ key.label }}</td>
              <td><code class="keys__hint">…{{ key.hint }}</code></td>
              <td class="keys__nowrap">{{ formatDate(key.createdAt) }}</td>
              <td class="keys__nowrap" :class="{ keys__expired: isExpired(key) }">
                <template v-if="!key.expiresAt">{{ t('settings.apiKeys.noExpiry') }}</template>
                <template v-else-if="isExpired(key)">{{ t('settings.apiKeys.expired', { date: formatDate(key.expiresAt) }) }}</template>
                <template v-else>{{ formatDate(key.expiresAt) }}</template>
              </td>
              <td class="keys__nowrap">{{ key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t('settings.apiKeys.never') }}</td>
              <td class="keys__actions">
                <AppButton
                  variant="ghost"
                  class="keys__danger"
                  :aria-label="t('settings.apiKeys.deleteLabel', { label: key.label })"
                  data-test="api-key-delete"
                  @click="askDelete(key)"
                >
                  {{ t('settings.apiKeys.delete') }}
                </AppButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <CreateApiKeyDialog v-model:open="createOpen" @created="onCreated" />

    <AppDialog
      v-model:open="deleteOpen"
      :title="toDelete ? t('settings.apiKeys.deleteTitle', { label: toDelete.label }) : ''"
      :description="t('settings.apiKeys.deleteText')"
    >
      <AppFormError :message="deleteError" />
      <div class="keys__dialog-actions">
        <AppButton variant="secondary" @click="deleteOpen = false">{{ t('common.cancel') }}</AppButton>
        <AppButton variant="danger" :loading="deleting" data-test="api-key-delete-confirm" @click="deleteKey">
          {{ t('settings.apiKeys.deleteConfirm') }}
        </AppButton>
      </div>
    </AppDialog>
  </PageLayout>
</template>

<style scoped>
.keys__wrap {
  overflow-x: auto;
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
}
.keys {
  width: 100%;
  border-collapse: collapse;
}
.keys th {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-align: left;
  white-space: nowrap;
}
.keys td {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  vertical-align: middle;
}
.keys tbody tr:last-child td {
  border-bottom: none;
}
.keys__label {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}
.keys__hint {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.keys__nowrap {
  white-space: nowrap;
}
.keys__expired {
  color: var(--color-danger);
}
.keys__actions {
  width: 1%;
  text-align: right;
}
.keys__danger {
  color: var(--color-danger);
}
.keys__muted {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.keys__dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
