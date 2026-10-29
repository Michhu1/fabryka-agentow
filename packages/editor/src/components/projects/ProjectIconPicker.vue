<script setup lang="ts">
import type { ProjectIcon } from '@app/shared';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ProjectIconView from './ProjectIconView.vue';
import { emojiIcon, PROJECT_EMOJI } from './project-display';

/** A button showing the project's icon that opens a grid of emoji to choose from (or "no icon"). */
const props = withDefaults(defineProps<{ type?: 'personal' | 'team'; disabled?: boolean }>(), {
  type: 'team',
  disabled: false,
});
const icon = defineModel<ProjectIcon | null>({ default: null });
const open = ref(false);
const { t } = useI18n();

function choose(value: ProjectIcon | null) {
  icon.value = value;
  open.value = false;
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      class="icon-picker__trigger"
      :disabled="disabled"
      :aria-label="
        icon ? t('projects.icon.chooseCurrent', { icon: icon.value }) : t('projects.icon.chooseNone')
      "
      data-test="icon-picker"
    >
      <ProjectIconView :project="{ type: props.type, icon }" size="md" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent class="icon-picker" align="start" :side-offset="6">
        <p class="icon-picker__title">{{ t('projects.icon.pickerTitle') }}</p>
        <div class="icon-picker__grid">
          <button
            v-for="emoji in PROJECT_EMOJI"
            :key="emoji"
            type="button"
            class="icon-picker__option"
            :aria-pressed="icon?.value === emoji"
            @click="choose(emojiIcon(emoji))"
          >
            {{ emoji }}
          </button>
        </div>
        <button type="button" class="icon-picker__none" @click="choose(null)">{{ t('projects.icon.none') }}</button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
/* Not scoped: the popover is teleported to <body>. */
.icon-picker__trigger {
  display: inline-grid;
  place-items: center;
  width: var(--control-height);
  height: var(--control-height);
  padding: 0;
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  cursor: pointer;
}
.icon-picker__trigger:hover:not(:disabled) {
  background: var(--color-surface-muted);
}
.icon-picker__trigger:disabled {
  background: var(--color-surface-muted);
  cursor: not-allowed;
}
.icon-picker {
  z-index: 60;
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
}
.icon-picker__title {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
}
.icon-picker__grid {
  display: grid;
  grid-template-columns: repeat(8, var(--icon-size-md));
  gap: var(--space-1);
}
.icon-picker__option {
  display: grid;
  place-items: center;
  width: var(--icon-size-md);
  height: var(--icon-size-md);
  padding: 0;
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--font-size-lg);
  cursor: pointer;
}
.icon-picker__option:hover {
  background: var(--color-surface-muted);
}
.icon-picker__option[aria-pressed='true'] {
  border-color: var(--color-primary);
  background: var(--color-nav-active);
}
.icon-picker__none {
  justify-self: start;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-link);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.icon-picker__none:hover {
  background: var(--color-surface-muted);
}
</style>
