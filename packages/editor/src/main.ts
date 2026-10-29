import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { i18n } from './i18n';
import { createAppRouter, reloadOnStaleChunk, watchSession } from './router';
import { applyTheme, storedTheme, watchUserTheme } from './theme';

// The last look used on this device, before the first paint (the account's theme follows once read).
applyTheme(storedTheme());

const pinia = createPinia();
const router = createAppRouter();
reloadOnStaleChunk(router);

createApp(App).use(pinia).use(i18n).use(router).mount('#app');
watchSession(router);
watchUserTheme();
