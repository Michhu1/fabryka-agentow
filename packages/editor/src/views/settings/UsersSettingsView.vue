<script setup lang="ts">
import type { DeleteUserConflict, GlobalRole, InstanceUser, UserList } from '@app/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, apiClient } from '../../api/client';
import PageLayout from '../../components/PageLayout.vue';
import InviteUsersDialog from '../../components/settings/InviteUsersDialog.vue';
import AppAlert from '../../components/ui/AppAlert.vue';
import AppButton from '../../components/ui/AppButton.vue';
import AppDialog from '../../components/ui/AppDialog.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import AppInput from '../../components/ui/AppInput.vue';
import AppSelect from '../../components/ui/AppSelect.vue';
import { globalRoleKey } from '../../i18n';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import { formatDay } from '../../utils/dates';

/**
 * Settings → Użytkownicy (n8n: Users), for the platform owner and admins: accounts only, never their
 * projects. The controls follow the server's rules — nobody acts on themselves or on the platform
 * owner, an admin acts only on members, and only the owner changes roles and invites admins.
 */
const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

const { t } = useI18n();
const auth = useAuthStore();
const errorText = useServerError();

const isPlatformOwner = computed(() => auth.user?.role === 'global:owner');

// --- List, search, pages ---------------------------------------------------------------------------
const search = ref('');
const skip = ref(0);
const list = ref<UserList>({ count: 0, items: [] });
const state = ref<'loading' | 'ready' | 'error'>('loading');
const listError = ref<string | null>(null);
const actionError = ref<string | null>(null);
let request = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  const current = ++request;
  try {
    const result = await apiClient.get<UserList>('/rest/users', {
      search: search.value.trim() || undefined,
      skip: skip.value,
      take: PAGE_SIZE,
    });
    if (current !== request) return;
    // The last account of a later page went away: show the page before it.
    if (result.items.length === 0 && skip.value > 0 && result.count > 0) {
      skip.value = Math.max(0, Math.floor((result.count - 1) / PAGE_SIZE) * PAGE_SIZE);
      await load();
      return;
    }
    list.value = result;
    listError.value = null;
    state.value = 'ready';
  } catch (caught) {
    if (current !== request) return;
    listError.value = errorText(caught);
    if (state.value === 'loading') state.value = 'error';
  }
}

watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    skip.value = 0;
    void load();
  }, SEARCH_DELAY_MS);
});
onMounted(load);
onBeforeUnmount(() => clearTimeout(searchTimer));

const rangeFrom = computed(() => (list.value.count === 0 ? 0 : skip.value + 1));
const rangeTo = computed(() => skip.value + list.value.items.length);
const hasPrevious = computed(() => skip.value > 0);
const hasNext = computed(() => skip.value + PAGE_SIZE < list.value.count);

function goTo(nextSkip: number) {
  skip.value = Math.max(0, nextSkip);
  void load();
}

// --- Per-row rules (the server's, so nobody clicks a button that can only fail) ---------------------
const isSelf = (user: InstanceUser) => user.id === auth.user?.id;
const canChangeRole = (user: InstanceUser) =>
  isPlatformOwner.value && !isSelf(user) && user.role !== 'global:owner';
const canManage = (user: InstanceUser) =>
  !isSelf(user) && user.role !== 'global:owner' && (isPlatformOwner.value || user.role === 'global:member');

const displayName = (user: InstanceUser) => `${user.firstName} ${user.lastName}`.trim() || user.email;
const status = (user: InstanceUser) => (user.disabled ? 'disabled' : user.isPending ? 'pending' : 'active');

function replace(updated: InstanceUser) {
  list.value = {
    ...list.value,
    items: list.value.items.map((item) => (item.id === updated.id ? updated : item)),
  };
}

// --- Role (platform owner only) --------------------------------------------------------------------
type AssignableRole = Exclude<GlobalRole, 'global:owner'>;
const busyId = ref<string | null>(null);
const roleOptions = computed(() =>
  (['global:member', 'global:admin'] as const).map((value) => ({ value, label: t(globalRoleKey(value)) })),
);

async function changeRole(user: InstanceUser, role: AssignableRole) {
  actionError.value = null;
  busyId.value = user.id;
  try {
    replace(await apiClient.patch<InstanceUser>(`/rest/users/${user.id}/role`, { role }));
  } catch (caught) {
    actionError.value = errorText(caught);
    // The select shows what the server has.
    await load();
  } finally {
    busyId.value = null;
  }
}

// --- Block / unblock / delete (with confirmation) --------------------------------------------------
type Action = { kind: 'disable' | 'enable' | 'delete'; user: InstanceUser };
const action = ref<Action | null>(null);
const actionOpen = computed({
  get: () => action.value !== null,
  set: (open) => {
    if (!open) action.value = null;
  },
});
const acting = ref(false);
const dialogError = ref<string | null>(null);
/**
 * 409 of a delete: how many team projects the account owns (never which ones); `unknown` when the
 * answer has no count (then a general message, not "0 projektów").
 */
const ownedProjects = ref<number | 'unknown' | null>(null);

function ask(kind: Action['kind'], user: InstanceUser) {
  dialogError.value = null;
  ownedProjects.value = null;
  action.value = { kind, user };
}

const dialogTitle = computed(() =>
  action.value ? t(`settings.users.${action.value.kind}Title`, { name: displayName(action.value.user) }) : '',
);
const dialogText = computed(() => (action.value ? t(`settings.users.${action.value.kind}Text`) : ''));

async function confirmAction() {
  const current = action.value;
  if (!current) return;
  dialogError.value = null;
  ownedProjects.value = null;
  acting.value = true;
  try {
    if (current.kind === 'delete') {
      await apiClient.delete(`/rest/users/${current.user.id}`);
      action.value = null;
      await load();
    } else {
      const disabled = current.kind === 'disable';
      replace(await apiClient.patch<InstanceUser>(`/rest/users/${current.user.id}`, { disabled }));
      action.value = null;
    }
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 409 && caught.message === 'User owns team projects') {
      const count = (caught.body as Partial<DeleteUserConflict>).projectCount;
      ownedProjects.value = typeof count === 'number' && count > 0 ? count : 'unknown';
    } else {
      dialogError.value = errorText(caught);
      if (caught instanceof ApiError && caught.status === 404) void load();
    }
  } finally {
    acting.value = false;
  }
}

// --- Invite ----------------------------------------------------------------------------------------
const inviteOpen = ref(false);
</script>

<template>
  <PageLayout :title="t('settings.users.title')" :subtitle="t('settings.users.subtitle')">
    <template #actions>
      <AppButton data-test="users-invite" @click="inviteOpen = true">{{ t('settings.users.invite') }}</AppButton>
    </template>

    <AppInput
      v-model="search"
      type="search"
      autocomplete="off"
      :maxlength="254"
      :label="t('settings.users.search')" class="users__search" data-test="users-search" />

    <p v-if="state === 'loading'" class="users__muted">{{ t('common.loading') }}</p>
    <AppFormError v-else-if="state === 'error'" :message="listError" />
    <template v-else>
      <AppFormError :message="listError ?? actionError" />
      <div class="users__table-wrap">
        <table class="users">
          <caption class="visually-hidden">{{ t('settings.users.listLabel') }}</caption>
          <thead>
            <tr>
              <th scope="col">{{ t('settings.users.columns.user') }}</th>
              <th scope="col">{{ t('settings.users.columns.role') }}</th>
              <th scope="col">{{ t('settings.users.columns.status') }}</th>
              <th scope="col">{{ t('settings.users.columns.mfa') }}</th>
              <th scope="col">{{ t('settings.users.columns.lastActive') }}</th>
              <th scope="col"><span class="visually-hidden">{{ t('settings.users.columns.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="list.items.length === 0">
              <td colspan="6" class="users__empty">{{ t('settings.users.empty') }}</td>
            </tr>
            <tr v-for="user in list.items" :key="user.id" data-test="user-row" :data-id="user.id">
              <td>
                <span class="users__person">
                  <span class="users__name">
                    {{ user.isPending ? t('settings.users.invited') : displayName(user) }}
                    <span v-if="isSelf(user)" class="users__you">({{ t('common.you') }})</span>
                  </span>
                  <span class="users__email">{{ user.email }}</span>
                </span>
              </td>
              <td class="users__role">
                <AppSelect
                  v-if="canChangeRole(user)"
                  :model-value="user.role as AssignableRole"
                  :options="roleOptions"
                  :label="t('settings.users.changeRole', { name: displayName(user) })"
                  hide-label
                  :disabled="busyId === user.id"
                  data-test="user-role"
                  @update:model-value="(role: AssignableRole) => changeRole(user, role)"
                />
                <span v-else :class="{ users__owner: user.role === 'global:owner' }">{{ t(globalRoleKey(user.role)) }}</span>
              </td>
              <td>
                <span class="users__status" :class="`users__status--${status(user)}`">
                  {{ t(`settings.users.status.${status(user)}`) }}
                </span>
              </td>
              <td>{{ user.mfaEnabled ? t('settings.users.mfaOn') : t('settings.users.mfaOff') }}</td>
              <td class="users__nowrap">{{ user.lastActiveAt ? formatDay(user.lastActiveAt) : t('settings.users.never') }}</td>
              <td class="users__actions">
                <template v-if="canManage(user)">
                  <AppButton
                    v-if="user.disabled"
                    variant="ghost"
                    :aria-label="t('settings.users.enableLabel', { name: displayName(user) })"
                    data-test="user-enable"
                    @click="ask('enable', user)"
                  >
                    {{ t('settings.users.enable') }}
                  </AppButton>
                  <AppButton
                    v-else
                    variant="ghost"
                    :aria-label="t('settings.users.disableLabel', { name: displayName(user) })"
                    data-test="user-disable"
                    @click="ask('disable', user)"
                  >
                    {{ t('settings.users.disable') }}
                  </AppButton>
                  <AppButton
                    variant="ghost"
                    class="users__danger"
                    :aria-label="t('settings.users.deleteLabel', { name: displayName(user) })"
                    data-test="user-delete"
                    @click="ask('delete', user)"
                  >
                    {{ t('settings.users.delete') }}
                  </AppButton>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <nav v-if="list.count > PAGE_SIZE || skip > 0" class="users__pages" :aria-label="t('settings.users.pagination')">
        <span class="users__muted" aria-live="polite">
          {{ t('settings.users.range', { from: rangeFrom, to: rangeTo, count: list.count }) }}
        </span>
        <AppButton variant="secondary" :disabled="!hasPrevious" data-test="users-previous" @click="goTo(skip - PAGE_SIZE)">
          {{ t('settings.users.previous') }}
        </AppButton>
        <AppButton variant="secondary" :disabled="!hasNext" data-test="users-next" @click="goTo(skip + PAGE_SIZE)">
          {{ t('settings.users.next') }}
        </AppButton>
      </nav>
    </template>

    <InviteUsersDialog v-model:open="inviteOpen" @invited="load" />

    <AppDialog v-model:open="actionOpen" :title="dialogTitle" :description="dialogText">
      <template v-if="action">
        <template v-if="ownedProjects !== null">
          <AppAlert variant="warning" data-test="user-owns-projects">
            {{
              ownedProjects === 'unknown'
                ? t('settings.users.ownsProjectsGeneric')
                : t('settings.users.ownsProjects', ownedProjects)
            }}
          </AppAlert>
          <p class="users__text">{{ t('settings.users.ownsProjectsHint') }}</p>
        </template>
        <AppFormError :message="dialogError" />
        <div class="users__dialog-actions">
          <AppButton variant="secondary" @click="actionOpen = false">{{ t('common.cancel') }}</AppButton>
          <AppButton
            v-if="ownedProjects !== null && !action.user.disabled"
            variant="primary"
            data-test="user-block-instead"
            @click="ask('disable', action.user)"
          >
            {{ t('settings.users.blockInstead') }}
          </AppButton>
          <AppButton
            v-else-if="ownedProjects === null"
            :variant="action.kind === 'enable' ? 'primary' : 'danger'"
            :loading="acting"
            data-test="user-action-confirm"
            @click="confirmAction"
          >
            {{ t(`settings.users.${action.kind}Confirm`) }}
          </AppButton>
        </div>
      </template>
    </AppDialog>
  </PageLayout>
</template>

<style scoped>
.users__search {
  max-width: 360px;
}
.users__table-wrap {
  overflow-x: auto;
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
}
.users {
  width: 100%;
  border-collapse: collapse;
}
.users th {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-align: left;
  white-space: nowrap;
}
.users td {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  vertical-align: middle;
}
.users tbody tr:last-child td {
  border-bottom: none;
}
.users__person {
  display: grid;
  min-width: 160px;
}
.users__name {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}
.users__you {
  font-weight: var(--font-weight-regular);
  color: var(--color-text-muted);
}
.users__email {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.users__role {
  min-width: 160px;
}
.users__owner {
  font-weight: var(--font-weight-semibold);
}
.users__status {
  display: inline-block;
  padding: 2px var(--space-2);
  border: var(--border-width) solid;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}
.users__status--active {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success);
}
.users__status--pending {
  background: var(--color-info-bg);
  border-color: var(--color-info-border);
  color: var(--color-info);
}
.users__status--disabled {
  background: var(--color-danger-bg);
  border-color: var(--color-danger-border);
  color: var(--color-danger);
}
.users__nowrap {
  white-space: nowrap;
}
.users__actions {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}
.users__danger {
  color: var(--color-danger);
}
.users__empty,
.users__muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.users__muted {
  margin: 0;
}
.users__empty {
  padding: var(--space-6) var(--space-3);
  text-align: center;
}
.users__pages {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.users__text {
  margin: 0;
}
.users__dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
