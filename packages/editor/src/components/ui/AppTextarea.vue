<script setup lang="ts">
import { computed, useId } from 'vue';

/** A multi-line text field with a label, like `AppInput`. */
const props = withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    error?: string;
    rows?: number;
    maxlength?: number;
    disabled?: boolean;
  }>(),
  { rows: 3, disabled: false },
);
const model = defineModel<string>({ default: '' });
const id = useId();
const describedBy = computed(
  () =>
    [props.error ? `${id}-error` : null, props.hint ? `${id}-hint` : null].filter(Boolean).join(' ') ||
    undefined,
);
</script>

<template>
  <div class="app-textarea" :class="{ 'app-textarea--invalid': !!error }">
    <label class="app-textarea__label" :for="id">{{ label }}</label>
    <textarea
      :id="id"
      v-model="model"
      class="app-textarea__field"
      :rows="rows"
      :maxlength="maxlength"
      :disabled="disabled"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
    />
    <p v-if="error" :id="`${id}-error`" class="app-textarea__error">{{ error }}</p>
    <p v-if="hint" :id="`${id}-hint`" class="app-textarea__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.app-textarea {
  display: grid;
  gap: var(--space-1);
}
.app-textarea__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.app-textarea__field {
  width: 100%;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  resize: vertical;
}
.app-textarea__field:focus {
  outline: none;
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}
.app-textarea__field:disabled {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}
.app-textarea--invalid .app-textarea__field {
  border-color: var(--color-danger);
}
.app-textarea__hint,
.app-textarea__error {
  margin: 0;
  font-size: var(--font-size-xs);
}
.app-textarea__hint {
  color: var(--color-text-muted);
}
.app-textarea__error {
  color: var(--color-danger);
}
</style>
