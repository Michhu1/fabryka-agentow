<script setup lang="ts">
import type { MemberRole, ProjectMember } from '@app/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { projectRoleKey } from '../../i18n';
import AppButton from '../ui/AppButton.vue';
import AppSelect from '../ui/AppSelect.vue';

/**
 * The members of a project with their roles. With `canManage` (the owner looking) editors and viewers
 * get a role switch and "Usuń"; the owner's own row never does — the owner can be neither demoted nor
 * removed (only a transfer changes the owner).
 */
const props = defineProps<{
  members: ProjectMember[];
  currentUserId: string;
  canManage: boolean;
  /** The member whose change is being saved (their controls are disabled meanwhile). */
  busyUserId?: string | null;
}>();
const emit = defineEmits<{
  changeRole: [userId: string, role: MemberRole];
  remove: [member: ProjectMember];
}>();
const { t } = useI18n();

const roleOptions = computed(() =>
  (['project:editor', 'project:viewer'] as const).map((value) => ({
    value,
    label: t(projectRoleKey(value)),
  })),
);

const fullName = (member: ProjectMember) => `${member.firstName} ${member.lastName}`.trim() || member.email;
const isMemberRole = (role: ProjectMember['role']): role is MemberRole =>
  role === 'project:editor' || role === 'project:viewer';
</script>

<template>
  <table class="members">
    <thead>
      <tr>
        <th scope="col">{{ t('projects.members.user') }}</th>
        <th scope="col">{{ t('projects.members.role') }}</th>
        <th v-if="canManage" scope="col"><span class="visually-hidden">{{ t('projects.members.actions') }}</span></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="member in props.members" :key="member.userId" data-test="member-row">
        <td>
          <span class="members__person">
            <span class="members__name">
              {{ fullName(member) }}
              <span v-if="member.userId === currentUserId" class="members__you">({{ t('common.you') }})</span>
            </span>
            <span class="members__email">{{ member.email }}</span>
          </span>
        </td>
        <td class="members__role">
          <AppSelect
            v-if="canManage && isMemberRole(member.role)"
            :model-value="member.role"
            :options="roleOptions"
            :label="t('projects.members.changeRole', { name: fullName(member) })"
            hide-label
            :disabled="busyUserId === member.userId"
            data-test="member-role"
            @update:model-value="(role: MemberRole) => emit('changeRole', member.userId, role)"
          />
          <span v-else :class="{ 'members__owner': !isMemberRole(member.role) }">{{ t(projectRoleKey(member.role)) }}</span>
        </td>
        <td v-if="canManage" class="members__actions">
          <AppButton
            v-if="isMemberRole(member.role)"
            variant="ghost"
            :disabled="busyUserId === member.userId"
            :aria-label="t('projects.members.removeLabel', { name: fullName(member) })"
            data-test="member-remove"
            @click="emit('remove', member)"
          >
            {{ t('projects.members.remove') }}
          </AppButton>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.members {
  width: 100%;
  border-collapse: collapse;
}
.members th {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-align: left;
}
.members td {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  vertical-align: middle;
}
.members tbody tr:last-child td {
  border-bottom: none;
}
.members__person {
  display: grid;
  min-width: 0;
}
.members__name {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}
.members__you {
  font-weight: var(--font-weight-regular);
  color: var(--color-text-muted);
}
.members__email {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.members__role {
  width: 160px;
}
.members__owner {
  font-weight: var(--font-weight-semibold);
}
.members__actions {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}
</style>
