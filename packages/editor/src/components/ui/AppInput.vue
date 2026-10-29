<script setup lang="ts">
import { computed, onMounted, useId, useTemplateRef } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    /** The field's `name` (password managers and browsers' autofill read it with `autocomplete`). */
    name?: string;
    type?: 'text' | 'email' | 'password' | 'tel' | 'search' | 'url' | 'date';
    autocomplete?: string;
    inputmode?: 'text' | 'numeric' | 'email' | 'tel' | 'search' | 'url';
    /** Help text under the field. */
    hint?: string;
    /** Error text under the field (marks the field invalid). */
    error?: string;
    required?: boolean;
    readonly?: boolean;
    disabled?: boolean;
    maxlength?: number;
    /** Earliest value of a `date` field (`YYYY-MM-DD`). */
    min?: string;
    autofocus?: boolean;
  }>(),
  { type: 'text', required: false, readonly: false, disabled: false, autofocus: false },
);

const model = defineModel<string>({ default: '' });
const id = useId();
const hintId = `${id}-hint`;
const errorId = `${id}-error`;
const input = useTemplateRef<HTMLInputElement>('input');
// The `autofocus` attribute only works on page load; fields shown later (e.g. the 2FA code) need this.
onMounted(() => {
  if (props.autofocus) input.value?.focus();
});
const describedBy = computed(
  () => [props.error ? errorId : null, props.hint ? hintId : null].filter(Boolean).join(' ') || undefined,
);
</script>

<template>
  <div class="app-input" :class="{ 'app-input--invalid': !!error }">
    <label class="app-input__label" :for="id">{{ label }}</label>
    <input
      :id="id"
      ref="input"
      v-model="model"
      class="app-input__field"
      :type="type"
      :name="name ?? id"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :required="required"
      :readonly="readonly"
      :disabled="disabled"
      :maxlength="maxlength"
      :min="min"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
    />
    <p v-if="error" :id="errorId" class="app-input__error">{{ error }}</p>
    <p v-if="hint" :id="hintId" class="app-input__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.app-input {
  display: grid;
  gap: var(--space-1);
}
.app-input__label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.app-input__field {
  width: 100%;
  min-width: 0;
  min-height: var(--control-height);
  padding: 0 var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}
.app-input__field:focus {
  outline: none;
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}
.app-input__field:read-only,
.app-input__field:disabled {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}
.app-input--invalid .app-input__field {
  border-color: var(--color-danger);
}
.app-input__hint,
.app-input__error {
  margin: 0;
  font-size: var(--font-size-xs);
}
.app-input__hint {
  color: var(--color-text-muted);
}
.app-input__error {
  color: var(--color-danger);
}
</style>
