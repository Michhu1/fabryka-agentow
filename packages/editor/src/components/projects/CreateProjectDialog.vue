<script setup lang="ts">
import type { ProjectIcon } from '@app/shared';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ApiError } from '../../api/client';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';
import AppButton from '../ui/AppButton.vue';
import AppDialog from '../ui/AppDialog.vue';
import AppFormError from '../ui/AppFormError.vue';
import AppInput from '../ui/AppInput.vue';
import ProjectIconPicker from './ProjectIconPicker.vue';

/** "Nowy projekt": name and emoji icon; on success opens the new project. */
const open = defineModel<boolean>('open', { default: false });

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const projects = useProjectsStore();
const errorText = useServerError();

const name = ref('');
const icon = ref<ProjectIcon | null>(null);
const error = ref<string | null>(null);
const saving = ref(false);

// Every opening starts empty.
watch(open, (isOpen) => {
  if (!isOpen) return;
  name.value = '';
  icon.value = null;
  error.value = null;
});

async function submit() {
  error.value = null;
  if (!name.value.trim()) {
    error.value = t('errors.nameRequired');
    return;
  }
  saving.value = true;
  try {
    const project = await projects.create({ name: name.value.trim(), icon: icon.value });
    open.value = false;
    await router.push({ name: 'project', params: { projectId: project.id } });
  } catch (caught) {
    error.value =
      caught instanceof ApiError && caught.message === 'Team project limit reached'
        ? t('projects.create.limitReached', { limit: auth.user?.teamProjectsLimit ?? '' })
        : errorText(caught);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppDialog v-model:open="open" :title="t('projects.create.title')" :description="t('projects.create.description')">
    <form class="create-project" novalidate @submit.prevent="submit">
      <div class="create-project__row">
        <div class="create-project__icon">
          <span class="create-project__label">{{ t('projects.icon.label') }}</span>
          <ProjectIconPicker v-model="icon" />
        </div>
        <AppInput
          v-model="name"
          class="create-project__name"
          :label="t('projects.create.name')"
          :maxlength="255"
          required
          autofocus
          data-test="project-name"
        />
      </div>
      <AppFormError :message="error" />
      <div class="create-project__actions">
        <AppButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</AppButton>
        <AppButton type="submit" :loading="saving">{{ t('projects.create.submit') }}</AppButton>
      </div>
    </form>
  </AppDialog>
</template>

<style scoped>
.create-project {
  display: grid;
  gap: var(--space-4);
}
.create-project__row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
}
.create-project__icon {
  display: grid;
  gap: var(--space-1);
}
.create-project__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.create-project__name {
  flex: 1;
}
.create-project__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
