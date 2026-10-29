<script setup lang="ts" generic="T extends string">
import { useId } from 'vue';

/**
 * A native select (keyboard and screen readers work as everywhere). `label` is shown above it, or only
 * read out when `hideLabel` is set (e.g. inside a table row whose header says what it is).
 */
defineProps<{
  label: string;
  options: { value: T; label: string }[];
  hideLabel?: boolean;
  disabled?: boolean;
  hint?: string;
}>();
const model = defineModel<T>({ required: true });
const id = useId();
</script>

<template>
  <div class="app-select">
    <label class="app-select__label" :class="{ 'visually-hidden': hideLabel }" :for="id">{{ label }}</label>
    <select
      :id="id"
      v-model="model"
      class="app-select__field"
      :disabled="disabled"
      :aria-describedby="hint ? `${id}-hint` : undefined"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <p v-if="hint" :id="`${id}-hint`" class="app-select__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.app-select {
  display: grid;
  gap: var(--space-1);
}
.app-select__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.app-select__field {
  min-height: var(--control-height);
  padding: 0 var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
}
.app-select__field:focus {
  outline: none;
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}
.app-select__field:disabled {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  cursor: not-allowed;
}
.app-select__hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
</style>
