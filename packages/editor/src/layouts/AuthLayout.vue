<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** Centered card of the signed-out pages (sign-in, sign-up, password reset, invitation links). */
defineProps<{ title: string; subtitle?: string }>();
const { t } = useI18n();
</script>

<template>
  <main class="auth-layout">
    <div class="auth-layout__column">
      <p class="auth-layout__brand">{{ t('common.appName') }}</p>
      <section class="auth-layout__card" aria-labelledby="auth-title">
        <header class="auth-layout__header">
          <h1 id="auth-title" class="auth-layout__title">{{ title }}</h1>
          <p v-if="subtitle" class="auth-layout__subtitle">{{ subtitle }}</p>
        </header>
        <slot />
      </section>
      <footer v-if="$slots.footer" class="auth-layout__footer">
        <slot name="footer" />
      </footer>
    </div>
  </main>
</template>

<style scoped>
.auth-layout {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--space-8) var(--space-4);
}
.auth-layout__column {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  width: 100%;
  max-width: var(--auth-card-width);
}
.auth-layout__brand {
  margin: 0;
  text-align: center;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
}
.auth-layout__card {
  display: grid;
  gap: var(--space-5);
  padding: var(--space-8);
  background: var(--color-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.auth-layout__header {
  display: grid;
  gap: var(--space-1);
}
.auth-layout__title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
}
.auth-layout__subtitle {
  margin: 0;
  color: var(--color-text-muted);
}
.auth-layout__footer {
  text-align: center;
  color: var(--color-text-muted);
}
@media (max-width: 480px) {
  .auth-layout__card {
    padding: var(--space-6) var(--space-4);
  }
}
</style>
