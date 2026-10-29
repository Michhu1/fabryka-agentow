<script setup lang="ts">
import type {
  MemberRole,
  ProjectDetails,
  ProjectIcon,
  ProjectInvitation,
  ProjectMember,
  ProjectTransfer,
} from '@app/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import PageLayout from '../components/PageLayout.vue';
import ProjectHeader from '../components/projects/ProjectHeader.vue';
import ProjectIconPicker from '../components/projects/ProjectIconPicker.vue';
import ProjectMembers from '../components/projects/ProjectMembers.vue';
import TransferProjectDialog from '../components/projects/TransferProjectDialog.vue';
import SettingsSection from '../components/SettingsSection.vue';
import AppAlert from '../components/ui/AppAlert.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppDialog from '../components/ui/AppDialog.vue';
import AppFormError from '../components/ui/AppFormError.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import AppTextarea from '../components/ui/AppTextarea.vue';
import { projectRoleKey } from '../i18n';
import { useServerError } from '../i18n/server-errors';
import { useAuthStore } from '../stores/auth';
import { isProjectGone, useProjectsStore } from '../stores/projects';
import { formatDateTime } from '../utils/dates';

/**
 * Project settings (`/projects/:projectId/settings`). Every member sees them; only the owner changes
 * anything. The owner: name, icon, description, member roles (Edytor/Podgląd) and removal,
 * invitations, transfer and deletion. Other members: everything read-only, plus "Opuść projekt".
 * The personal project: only its icon.
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const projects = useProjectsStore();
const errorText = useServerError();

const projectId = String(route.params.projectId);
const project = ref<ProjectDetails | null>(null);
const state = ref<'loading' | 'ready' | 'not-found' | 'error'>('loading');
const loadError = ref<string | null>(null);

const isTeam = computed(() => project.value?.type === 'team');
const isOwner = computed(
  () => project.value?.role === 'project:admin' || project.value?.role === 'project:personalOwner',
);
const manageTeam = computed(() => isTeam.value && isOwner.value);

// --- Project info ----------------------------------------------------------------------------------
const name = ref('');
const icon = ref<ProjectIcon | null>(null);
const description = ref('');
const saving = ref(false);
const saved = ref(false);
const infoError = ref<string | null>(null);

function resetInfo() {
  name.value = project.value?.name ?? '';
  icon.value = project.value?.icon ?? null;
  description.value = project.value?.description ?? '';
  infoError.value = null;
}

const dirty = computed(() => {
  const current = project.value;
  if (!current) return false;
  return (
    name.value !== current.name ||
    icon.value?.value !== current.icon?.value ||
    description.value !== (current.description ?? '')
  );
});
// "Zapisano" disappears as soon as something is edited again.
watch(dirty, (isDirty) => {
  if (isDirty) saved.value = false;
});

async function saveInfo() {
  if (!project.value || !dirty.value) return;
  infoError.value = null;
  if (isTeam.value && !name.value.trim()) {
    infoError.value = t('errors.nameRequired');
    return;
  }
  saving.value = true;
  try {
    const patch = isTeam.value
      ? { name: name.value.trim(), icon: icon.value, description: description.value.trim() || null }
      : { icon: icon.value };
    project.value = await projects.update(project.value.id, patch);
    resetInfo();
    saved.value = true;
  } catch (caught) {
    await handleProjectError(caught, infoError);
  } finally {
    saving.value = false;
  }
}

// --- Members ---------------------------------------------------------------------------------------
const busyUserId = ref<string | null>(null);
const membersError = ref<string | null>(null);
const memberToRemove = ref<ProjectMember | null>(null);
const removeOpen = computed({
  get: () => memberToRemove.value !== null,
  set: (open) => {
    if (!open) memberToRemove.value = null;
  },
});
const removing = ref(false);

const memberName = (member: ProjectMember) => `${member.firstName} ${member.lastName}`.trim() || member.email;

/** Set when a re-read showed that the user's role changed meanwhile (e.g. a transfer accepted elsewhere). */
const roleChanged = ref(false);

/** Closes every dialog (the page under them changed). */
function closeDialogs() {
  memberToRemove.value = null;
  transferOpen.value = false;
  leaveOpen.value = false;
  deleteOpen.value = false;
}

/** Reads the project again after a 403: the role may have changed elsewhere. */
async function reread() {
  const before = project.value?.role;
  try {
    project.value = await projects.get(projectId);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) {
      closeDialogs();
      state.value = 'not-found';
    }
    return;
  }
  if (project.value.role !== before) {
    roleChanged.value = true;
    closeDialogs();
    resetInfo();
    if (manageTeam.value) await loadOwnerData();
  }
}

/**
 * The common handling of a failed project call: a 404 "Project not found" means the project is gone for
 * us (deleted, or we were removed) — show that instead; a 403 means our role changed — re-read it.
 * Anything else goes to `target`, next to the action.
 */
async function handleProjectError(caught: unknown, target: { value: string | null }) {
  if (isProjectGone(caught)) {
    closeDialogs();
    state.value = 'not-found';
    return;
  }
  target.value = errorText(caught);
  if (caught instanceof ApiError && caught.status === 403) await reread();
}

async function changeRole(userId: string, role: MemberRole) {
  if (!project.value) return;
  membersError.value = null;
  busyUserId.value = userId;
  try {
    project.value = await projects.updateMember(project.value.id, userId, role);
  } catch (caught) {
    await handleProjectError(caught, membersError);
  } finally {
    busyUserId.value = null;
  }
}

async function removeMember() {
  const target = memberToRemove.value;
  if (!project.value || !target) return;
  membersError.value = null;
  removing.value = true;
  try {
    project.value = await projects.removeMember(project.value.id, target.userId);
    memberToRemove.value = null;
  } catch (caught) {
    memberToRemove.value = null;
    await handleProjectError(caught, membersError);
  } finally {
    removing.value = false;
  }
}

// --- Invitations (owner) ---------------------------------------------------------------------------
const invitations = ref<ProjectInvitation[]>([]);
const inviteEmail = ref('');
const inviteRole = ref<MemberRole>('project:editor');
const inviting = ref(false);
const inviteError = ref<string | null>(null);
const inviteSent = ref<string | null>(null);
const cancellingId = ref<string | null>(null);

const roleOptions = computed(() =>
  (['project:editor', 'project:viewer'] as const).map((value) => ({
    value,
    label: t(projectRoleKey(value)),
  })),
);

async function loadInvitations() {
  invitations.value = await projects.invitations(projectId);
}

async function invite() {
  inviteError.value = null;
  inviteSent.value = null;
  if (!inviteEmail.value.trim()) {
    inviteError.value = t('errors.emailRequired');
    return;
  }
  inviting.value = true;
  try {
    const result = await projects.invite(projectId, inviteEmail.value.trim(), inviteRole.value);
    // The same answer whether or not the address has an account: say only that the mail went out.
    inviteSent.value = t('projects.invite.sent', { email: result.email });
    inviteEmail.value = '';
    await loadInvitations();
  } catch (caught) {
    await handleProjectError(caught, inviteError);
  } finally {
    inviting.value = false;
  }
}

async function cancelInvitation(invitation: ProjectInvitation) {
  inviteError.value = null;
  cancellingId.value = invitation.id;
  try {
    await projects.cancelInvitation(projectId, invitation.id);
  } catch (caught) {
    // Already gone (accepted or cancelled elsewhere): the reload below shows the truth.
    if (!(caught instanceof ApiError && caught.message === 'Invitation not found')) {
      await handleProjectError(caught, inviteError);
    }
  } finally {
    cancellingId.value = null;
  }
  await loadInvitations().catch(() => undefined);
}

// --- Transfer (owner) ------------------------------------------------------------------------------
const transfer = ref<ProjectTransfer | null>(null);
const transferOpen = ref(false);
const transferError = ref<string | null>(null);
const cancellingTransfer = ref(false);

async function loadTransfer() {
  transfer.value = await projects.transfer(projectId);
}

/** The pending box below says what happened (the same whether or not the address has an account). */
/** The dialog's call found the project gone or the role changed: handled here, the dialog closes. */
function onTransferProjectError(caught: unknown) {
  void handleProjectError(caught, transferError);
}

function onTransferSent(result: { email: string; expiresAt: string }) {
  transferError.value = null;
  transfer.value = { email: result.email, expiresAt: result.expiresAt, createdAt: new Date().toISOString() };
}

async function cancelTransfer() {
  transferError.value = null;
  cancellingTransfer.value = true;
  try {
    await projects.cancelTransfer(projectId);
    transfer.value = null;
  } catch (caught) {
    if (caught instanceof ApiError && caught.message === 'Transfer not found') transfer.value = null;
    else await handleProjectError(caught, transferError);
  } finally {
    cancellingTransfer.value = false;
  }
}

// --- Leave (members) -------------------------------------------------------------------------------
const leaveOpen = ref(false);
const leaving = ref(false);
const leaveError = ref<string | null>(null);

watch(leaveOpen, () => {
  leaveError.value = null;
});

async function leave() {
  leaveError.value = null;
  leaving.value = true;
  try {
    await projects.leave(projectId);
    leaveOpen.value = false;
    await router.push({ name: 'home' });
  } catch (caught) {
    await handleProjectError(caught, leaveError);
  } finally {
    leaving.value = false;
  }
}

// --- Delete (owner) --------------------------------------------------------------------------------
const deleteOpen = ref(false);
const deleteName = ref('');
const deleting = ref(false);
const deleteError = ref<string | null>(null);
const deleteConfirmed = computed(() => !!project.value && deleteName.value.trim() === project.value.name);

watch(deleteOpen, () => {
  deleteName.value = '';
  deleteError.value = null;
});

async function deleteProject() {
  if (!deleteConfirmed.value) return;
  deleteError.value = null;
  deleting.value = true;
  try {
    await projects.remove(projectId);
    deleteOpen.value = false;
    await router.push({ name: 'home' });
  } catch (caught) {
    await handleProjectError(caught, deleteError);
  } finally {
    deleting.value = false;
  }
}

// --- Load ------------------------------------------------------------------------------------------
/** Pending invitations and transfer: the owner's part of the page. */
async function loadOwnerData() {
  await Promise.all([
    loadInvitations().catch((caught) => handleProjectError(caught, inviteError)),
    loadTransfer().catch((caught) => handleProjectError(caught, transferError)),
  ]);
}

onMounted(async () => {
  try {
    project.value = await projects.get(projectId);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) state.value = 'not-found';
    else {
      state.value = 'error';
      loadError.value = errorText(caught);
    }
    return;
  }
  resetInfo();
  state.value = 'ready';
  if (manageTeam.value) await loadOwnerData();
});
</script>

<template>
  <PageLayout>
    <p v-if="state === 'loading'" class="settings__muted">{{ t('common.loading') }}</p>
    <EmptyState v-else-if="state === 'not-found'" :title="t('projects.notFound')" :level="1">
      <AppButton :to="{ name: 'home' }" variant="secondary">{{ t('projects.backToOverview') }}</AppButton>
    </EmptyState>
    <AppFormError v-else-if="state === 'error'" :message="loadError" />
    <template v-else-if="project">
      <ProjectHeader :project="project">
        <AppButton variant="secondary" :to="{ name: 'project', params: { projectId: project.id } }">
          {{ t('projects.settings.backToProject') }}
        </AppButton>
      </ProjectHeader>
      <h2 class="settings__title">{{ t('projects.settings.title') }}</h2>
      <AppAlert v-if="roleChanged" variant="info" data-test="role-changed">
        {{ t('projects.settings.roleChanged', { role: t(projectRoleKey(project.role)) }) }}
      </AppAlert>

      <SettingsSection :title="t('projects.settings.info')">
        <AppAlert v-if="!isOwner" variant="info">{{ t('projects.settings.readOnly') }}</AppAlert>
        <AppAlert v-else-if="!isTeam" variant="info">{{ t('projects.settings.personalHint') }}</AppAlert>
        <form class="settings__form" novalidate data-test="info-form" @submit.prevent="saveInfo">
          <div class="settings__name-row">
            <div class="settings__icon">
              <span class="settings__label">{{ t('projects.icon.label') }}</span>
              <ProjectIconPicker v-model="icon" :type="project.type" :disabled="!isOwner" />
            </div>
            <AppInput
              v-if="isTeam"
              v-model="name"
              class="settings__grow"
              :label="t('projects.settings.name')"
              :maxlength="255"
              :disabled="!isOwner"
              data-test="project-name"
            />
          </div>
          <AppTextarea
            v-if="isTeam"
            v-model="description"
            :label="t('projects.settings.description')"
            :maxlength="512"
            :disabled="!isOwner"
            data-test="project-description"
          />
          <AppFormError :message="infoError" />
          <AppAlert v-if="saved" variant="success">{{ t('common.saved') }}</AppAlert>
          <div v-if="isOwner" class="settings__actions">
            <AppButton variant="secondary" :disabled="!dirty || saving" @click="resetInfo">
              {{ t('common.cancel') }}
            </AppButton>
            <AppButton type="submit" :disabled="!dirty" :loading="saving" data-test="save">
              {{ t('common.save') }}
            </AppButton>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection
        v-if="isTeam"
        :title="t('projects.members.title')"
        :description="manageTeam ? t('projects.members.roleHint') : undefined"
      >
        <AppFormError :message="membersError" />
        <ProjectMembers
          :members="project.members"
          :current-user-id="auth.user?.id ?? ''"
          :can-manage="manageTeam"
          :busy-user-id="busyUserId"
          @change-role="changeRole"
          @remove="(member) => (memberToRemove = member)"
        />
      </SettingsSection>

      <SettingsSection
        v-if="manageTeam"
        :title="t('projects.invite.title')"
        :description="t('projects.invite.description')"
        data-test="invite-section"
      >
        <form class="settings__invite" novalidate data-test="invite-form" @submit.prevent="invite">
          <AppInput
            v-model="inviteEmail"
            class="settings__grow"
            type="email"
            autocomplete="off"
            :label="t('projects.invite.email')"
            data-test="invite-email"
          />
          <AppSelect v-model="inviteRole" :label="t('projects.invite.role')" :options="roleOptions" data-test="invite-role" />
          <AppButton type="submit" :loading="inviting">{{ t('projects.invite.submit') }}</AppButton>
        </form>
        <AppFormError :message="inviteError" />
        <AppAlert v-if="inviteSent" variant="success">{{ inviteSent }}</AppAlert>

        <div class="settings__subsection">
          <h3 class="settings__subtitle">{{ t('projects.invite.pending') }}</h3>
          <p v-if="invitations.length === 0" class="settings__muted">{{ t('projects.invite.noPending') }}</p>
          <ul v-else class="settings__list">
            <li v-for="item in invitations" :key="item.id" class="settings__list-item">
              <span class="settings__list-text">
                <span class="settings__strong">{{ item.email }}</span>
                <span class="settings__muted">
                  {{ t(projectRoleKey(item.role)) }} · {{ t('projects.invite.expires', { date: formatDateTime(item.expiresAt) }) }}
                </span>
              </span>
              <AppButton
                variant="ghost"
                :loading="cancellingId === item.id"
                :aria-label="t('projects.invite.cancelLabel', { email: item.email })"
                data-test="invitation-cancel"
                @click="cancelInvitation(item)"
              >
                {{ t('projects.invite.cancel') }}
              </AppButton>
            </li>
          </ul>
        </div>
      </SettingsSection>

      <SettingsSection
        v-if="manageTeam"
        :title="t('projects.transfer.title')"
        :description="t('projects.transfer.description')"
        data-test="transfer-section"
      >
        <AppFormError :message="transferError" />
        <div v-if="transfer" class="settings__list-item settings__pending" data-test="transfer-pending">
          <span>{{ t('projects.transfer.pending', { email: transfer.email, date: formatDateTime(transfer.expiresAt) }) }}</span>
          <AppButton variant="secondary" :loading="cancellingTransfer" data-test="transfer-cancel" @click="cancelTransfer">
            {{ t('projects.transfer.cancel') }}
          </AppButton>
        </div>
        <div>
          <AppButton variant="secondary" data-test="transfer" @click="transferOpen = true">
            {{ t('projects.transfer.button') }}
          </AppButton>
        </div>
        <TransferProjectDialog
          v-model:open="transferOpen"
          :project-id="project.id"
          :project-name="project.name"
          :has-pending="!!transfer"
          @sent="onTransferSent"
          @project-error="onTransferProjectError"
        />
      </SettingsSection>

      <SettingsSection
        v-if="isTeam && !isOwner"
        :title="t('projects.leave.title')"
        :description="t('projects.leave.description')"
        data-test="leave-section"
      >
        <div>
          <AppButton variant="secondary" data-test="leave" @click="leaveOpen = true">{{ t('projects.leave.button') }}</AppButton>
        </div>
      </SettingsSection>

      <SettingsSection
        v-if="manageTeam"
        danger
        :title="t('projects.danger.title')"
        :description="t('projects.danger.description')"
      >
        <div>
          <AppButton variant="danger" data-test="delete" @click="deleteOpen = true">{{ t('projects.danger.button') }}</AppButton>
        </div>
      </SettingsSection>

      <AppDialog
        v-model:open="removeOpen"
        :title="t('projects.members.removeTitle')"
        :description="
          memberToRemove ? t('projects.members.removeText', { name: memberName(memberToRemove), project: project.name }) : ''
        "
      >
        <div class="settings__dialog-actions">
          <AppButton variant="secondary" @click="removeOpen = false">{{ t('common.cancel') }}</AppButton>
          <AppButton variant="danger" :loading="removing" data-test="member-remove-confirm" @click="removeMember">
            {{ t('projects.members.removeConfirm') }}
          </AppButton>
        </div>
      </AppDialog>

      <AppDialog
        v-model:open="leaveOpen"
        :title="t('projects.leave.confirmTitle', { name: project.name })"
        :description="t('projects.leave.description')"
      >
        <AppFormError :message="leaveError" />
        <div class="settings__dialog-actions">
          <AppButton variant="secondary" @click="leaveOpen = false">{{ t('common.cancel') }}</AppButton>
          <AppButton variant="danger" :loading="leaving" data-test="leave-confirm" @click="leave">
            {{ t('projects.leave.confirm') }}
          </AppButton>
        </div>
      </AppDialog>

      <AppDialog
        v-model:open="deleteOpen"
        :title="t('projects.danger.confirmTitle', { name: project.name })"
        :description="t('projects.danger.confirmText')"
      >
        <form class="settings__form" novalidate @submit.prevent="deleteProject">
          <AppInput
            v-model="deleteName"
            autocomplete="off"
            :label="t('projects.danger.confirmLabel', { name: project.name })"
            autofocus
            data-test="delete-name"
          />
          <AppFormError :message="deleteError" />
          <div class="settings__dialog-actions">
            <AppButton variant="secondary" @click="deleteOpen = false">{{ t('common.cancel') }}</AppButton>
            <AppButton
              type="submit"
              variant="danger"
              :disabled="!deleteConfirmed"
              :loading="deleting"
              data-test="delete-confirm"
            >
              {{ t('projects.danger.confirm') }}
            </AppButton>
          </div>
        </form>
      </AppDialog>
    </template>
  </PageLayout>
</template>

<style scoped>
.settings__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.settings__form {
  display: grid;
  gap: var(--space-4);
}
.settings__name-row,
.settings__invite {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}
.settings__icon {
  display: grid;
  gap: var(--space-1);
}
.settings__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.settings__grow {
  flex: 1 1 240px;
}
.settings__actions,
.settings__dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.settings__subsection {
  display: grid;
  gap: var(--space-2);
}
.settings__subtitle {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}
.settings__list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
}
.settings__list > li + li {
  border-top: var(--border-width) solid var(--color-border);
}
.settings__list-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-2) var(--space-3);
}
.settings__pending {
  background: var(--color-warning-bg);
  border: var(--border-width) solid var(--color-warning-border);
  border-radius: var(--radius-md);
}
.settings__list-text {
  display: grid;
  min-width: 0;
}
.settings__strong {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}
.settings__muted {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
</style>
