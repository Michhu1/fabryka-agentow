<script setup lang="ts">
import AppAlert from './AppAlert.vue';

/** The form-level error (e.g. a translated server message); renders nothing when empty. */
defineProps<{ message?: string | null }>();
</script>

<template>
  <AppAlert v-if="message" variant="danger" class="app-form-error">{{ message }}</AppAlert>
</template>
