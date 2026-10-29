<script setup lang="ts">
import type { GlobalRole, InvitationResult } from '@app/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiClient } from '../../api/client';
import { globalRoleKey } from '../../i18n';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import AppButton from '../ui/AppButton.vue';
import AppDialog from '../ui/AppDialog.vue';
import AppFormError from '../ui/AppFormError.vue';
import AppSelect from '../ui/AppSelect.vue';
import AppTextarea from '../ui/AppTextarea.vue';

/**
 * "Zaproś" on the Users page: several addresses at once (up to 20, as the server allows) and a role.
 * Only the platform owner may invite administrators. Afterwards the dialog shows, per address, whether
 * the invitation went out or an account already exists.
 */
const emit = defineEmits<{ invited: [] }>();
const open = defineModel<boolean>('open', { default: false });

const MAX_EMAILS = 20;
/** A rough shape check before sending; the server validates every address anyway. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const { t } = useI18n();
const auth = useAuthStore();
const errorText = useServerError();

type InviteRole = Exclude<GlobalRole, 'global:owner'>;
const emailsText = ref('');
const role = ref<InviteRole>('global:member');
const error = ref<string | null>(null);
const sending = ref(false);
const results = ref<InvitationResult[] | null>(null);

const roleOptions = computed(() =>
  (auth.user?.role === 'global:owner'
    ? (['global:member', 'global:admin'] as const)
    : (['global:member'] as const)
  ).map((value) => ({ value, label: t(globalRoleKey(value)) })),
);

watch(open, (isOpen) => {
  if (!isOpen) return;
  emailsText.value = '';
  role.value = 'global:member';
  error.value = null;
  results.value = null;
});

/** The addresses typed in: separated by commas, semicolons, spaces or lines; duplicates once. */
function parseEmails(text: string): string[] {
  const all = text
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(all)];
}

async function submit() {
  error.value = null;
  const emails = parseEmails(emailsText.value);
  if (emails.length === 0) {
    error.value = t('errors.emailsRequired');
    return;
  }
  if (emails.length > MAX_EMAILS) {
    error.value = t('errors.tooManyEmails');
    return;
  }
  const invalid = emails.filter((email) => !EMAIL_SHAPE.test(email));
  if (invalid.length > 0) {
    error.value = t('settings.invite.invalidEmails', { emails: invalid.join(', ') });
    return;
  }
  sending.value = true;
  try {
    results.value = await apiClient.post<InvitationResult[]>('/rest/invitations', {
      emails,
      role: role.value,
    });
    emit('invited');
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <AppDialog v-model:open="open" :title="t('settings.invite.title')" :description="t('settings.invite.description')">
    <div v-if="results" class="invite">
      <h3 class="invite__subtitle">{{ t('settings.invite.results') }}</h3>
      <ul class="invite__results" data-test="invite-results">
        <li v-for="item in results" :key="item.email" class="invite__result" :data-status="item.status">
          <span class="invite__email">{{ item.email }}</span>
          <span :class="item.status === 'invited' ? 'invite__ok' : 'invite__muted'">
            {{ item.status === 'invited' ? t('settings.invite.statusInvited') : t('settings.invite.statusExists') }}
          </span>
        </li>
      </ul>
      <div class="invite__actions">
        <AppButton data-test="invite-done" @click="open = false">{{ t('settings.invite.done') }}</AppButton>
      </div>
    </div>
    <form v-else class="invite" novalidate data-test="invite-form" @submit.prevent="submit">
      <AppTextarea
        v-model="emailsText"
        :label="t('settings.invite.emails')"
        :hint="t('settings.invite.emailsHint')"
        :rows="4"
        data-test="invite-emails"
      />
      <AppSelect
        v-model="role"
        :label="t('settings.invite.role')"
        :options="roleOptions"
        :hint="roleOptions.length > 1 ? t('settings.invite.roleHint') : undefined"
        data-test="invite-role"
      />
      <AppFormError :message="error" />
      <div class="invite__actions">
        <AppButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</AppButton>
        <AppButton type="submit" :loading="sending" data-test="invite-submit">{{ t('settings.invite.submit') }}</AppButton>
      </div>
    </form>
  </AppDialog>
</template>

<style scoped>
/* Scoped styles also reach this component's content teleported into the dialog. */
.invite {
  display: grid;
  gap: var(--space-4);
}
.invite__subtitle {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}
.invite__results {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
}
.invite__result {
  display: grid;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
}
.invite__result + .invite__result {
  border-top: var(--border-width) solid var(--color-border);
}
.invite__email {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}
.invite__ok {
  font-size: var(--font-size-sm);
  color: var(--color-success);
}
.invite__muted {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.invite__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
