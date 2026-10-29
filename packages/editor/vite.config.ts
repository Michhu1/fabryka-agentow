/// <reference types="vitest/config" />
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const server = process.env.VITE_DEV_PROXY_TARGET ?? 'http://localhost:5680';

export default defineConfig({
  plugins: [vue()],
  // vue-i18n build flags: Composition API only, no devtools in production builds.
  define: {
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  server: {
    port: 5681,
    strictPort: true,
    proxy: {
      '/rest': server,
      '/api': server,
      '/healthz': server,
    },
  },
  test: {
    environment: 'jsdom',
  },
});
