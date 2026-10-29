<script setup lang="ts">
import { RouterView } from 'vue-router';
import ServerUnavailable from './components/ServerUnavailable.vue';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
</script>

<template>
  <ServerUnavailable v-if="auth.offline" />
  <RouterView v-else />
</template>

<style>
/*
 * Design tokens: the only place with raw colors (swapped wholesale in stage 2). Components use these
 * variables only. Light is the default; dark applies when the user chose it, or when they kept "System"
 * and the operating system is dark (`applyTheme` in theme.ts sets `data-theme` on <html>).
 */
:root {
  color-scheme: light;

  /* Surfaces and text */
  --color-bg: #f5f5f7;
  --color-surface: #ffffff;
  --color-surface-muted: #f0f0f3;
  --color-border: #d9d9df;
  --color-border-strong: #b8b8c2;
  --color-text: #1d1d1f;
  --color-text-muted: #6e6e73;
  --color-text-disabled: #a1a1a8;

  /* Brand / actions */
  --color-primary: #4f46e5;
  --color-primary-hover: #4338ca;
  --color-primary-active: #3730a3;
  --color-on-primary: #ffffff;
  --color-link: #4338ca;
  --color-focus: #6366f1;
  --color-focus-ring: rgb(99 102 241 / 0.35);

  /* States */
  --color-success: #1a7f37;
  --color-success-bg: #e6f4ea;
  --color-success-border: #a6d8b3;
  --color-danger: #cf222e;
  --color-danger-hover: #a40e26;
  --color-danger-bg: #fdecec;
  --color-danger-border: #f2b8bc;
  --color-warning: #9a6700;
  --color-warning-bg: #fff4d6;
  --color-warning-border: #f0d48a;
  --color-info: #0b5cad;
  --color-info-bg: #e8f1fc;
  --color-info-border: #b4d0f2;

  /* Navigation and overlays */
  --color-sidebar: #fbfbfc;
  --color-nav-hover: #ececf0;
  --color-nav-active: #e6e5fb;
  --color-nav-active-text: #3730a3;
  --color-overlay: rgb(15 15 20 / 0.45);
  --color-avatar: #e0e7ff;
  --color-on-avatar: #3730a3;
  /* The same in every theme: the frame of QR codes (scanners need dark-on-light) and the previews of
     the light and dark themes in the theme picker. */
  --color-qr-frame: #ffffff;
  --color-swatch-light: #f5f5f7;
  --color-swatch-dark: #1c1c1e;

  /* Spacing (4px grid) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  /* Shape */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --border-width: 1px;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px rgb(0 0 0 / 0.06);
  --shadow-popover: 0 4px 12px rgb(0 0 0 / 0.08), 0 12px 32px rgb(0 0 0 / 0.12);

  /* Type */
  --font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-family-mono: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  --font-size-xs: 12px;
  --font-size-sm: 13px;
  --font-size-md: 14px;
  --font-size-lg: 16px;
  --font-size-xl: 22px;
  --font-size-2xl: 28px;
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --line-height: 1.5;

  /* Controls */
  --control-height: 38px;
  --auth-card-width: 400px;
  --sidebar-width: 248px;
  --content-width: 960px;
  --dialog-width: 480px;
  --icon-size-sm: 24px;
  --icon-size-md: 32px;
  --icon-size-lg: 40px;
  --transition-fast: 120ms ease;
}
/* Dark: chosen in the settings (`data-theme`, see theme.ts)… */
:root[data-theme='dark'] {
  color-scheme: dark;

  --color-bg: #1c1c1e;
  --color-surface: #26262a;
  --color-surface-muted: #2f2f34;
  --color-border: #3d3d44;
  --color-border-strong: #56565f;
  --color-text: #f5f5f7;
  --color-text-muted: #a1a1a6;
  --color-text-disabled: #6b6b72;

  --color-primary: #5850ec;
  --color-primary-hover: #6d66f5;
  --color-primary-active: #4f46e5;
  --color-on-primary: #ffffff;
  --color-link: #a5b4fc;
  --color-focus: #818cf8;
  --color-focus-ring: rgb(129 140 248 / 0.45);

  --color-success: #3fb950;
  --color-success-bg: #12261a;
  --color-success-border: #23552f;
  --color-danger: #f85149;
  --color-danger-hover: #ff7b72;
  --color-danger-bg: #2d1416;
  --color-danger-border: #6e2a2d;
  --color-warning: #d29922;
  --color-warning-bg: #2b2210;
  --color-warning-border: #634c17;
  --color-info: #79b8ff;
  --color-info-bg: #132235;
  --color-info-border: #24476f;

  --color-sidebar: #202023;
  --color-nav-hover: #2f2f34;
  --color-nav-active: #2e2c5a;
  --color-nav-active-text: #c7d2fe;
  --color-overlay: rgb(0 0 0 / 0.6);
  --color-avatar: #2e2c5a;
  --color-on-avatar: #c7d2fe;
  --color-qr-frame: #ffffff;
  --color-swatch-light: #f5f5f7;
  --color-swatch-dark: #1c1c1e;

  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.3), 0 4px 16px rgb(0 0 0 / 0.35);
  --shadow-popover: 0 4px 12px rgb(0 0 0 / 0.4), 0 12px 32px rgb(0 0 0 / 0.5);
}
/* …or the system is dark and light was not chosen. Keep both dark sets identical (checked by theme.test.ts). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

    --color-bg: #1c1c1e;
    --color-surface: #26262a;
    --color-surface-muted: #2f2f34;
    --color-border: #3d3d44;
    --color-border-strong: #56565f;
    --color-text: #f5f5f7;
    --color-text-muted: #a1a1a6;
    --color-text-disabled: #6b6b72;

    --color-primary: #5850ec;
    --color-primary-hover: #6d66f5;
    --color-primary-active: #4f46e5;
    --color-on-primary: #ffffff;
    --color-link: #a5b4fc;
    --color-focus: #818cf8;
    --color-focus-ring: rgb(129 140 248 / 0.45);

    --color-success: #3fb950;
    --color-success-bg: #12261a;
    --color-success-border: #23552f;
    --color-danger: #f85149;
    --color-danger-hover: #ff7b72;
    --color-danger-bg: #2d1416;
    --color-danger-border: #6e2a2d;
    --color-warning: #d29922;
    --color-warning-bg: #2b2210;
    --color-warning-border: #634c17;
    --color-info: #79b8ff;
    --color-info-bg: #132235;
    --color-info-border: #24476f;

    --color-sidebar: #202023;
    --color-nav-hover: #2f2f34;
    --color-nav-active: #2e2c5a;
    --color-nav-active-text: #c7d2fe;
    --color-overlay: rgb(0 0 0 / 0.6);
    --color-avatar: #2e2c5a;
    --color-on-avatar: #c7d2fe;
    --color-qr-frame: #ffffff;
    --color-swatch-light: #f5f5f7;
    --color-swatch-dark: #1c1c1e;

    --shadow-card: 0 1px 2px rgb(0 0 0 / 0.3), 0 4px 16px rgb(0 0 0 / 0.35);
    --shadow-popover: 0 4px 12px rgb(0 0 0 / 0.4), 0 12px 32px rgb(0 0 0 / 0.5);
  }
}
html,
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-family);
  font-size: var(--font-size-md);
  line-height: var(--line-height);
}
*,
*::before,
*::after {
  box-sizing: border-box;
}
a {
  color: var(--color-link);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
/* For screen readers only: hidden on screen, still read out (labels, table headers, captions). */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
