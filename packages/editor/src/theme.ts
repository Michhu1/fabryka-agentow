import type { Theme } from '@app/shared';
import { watch } from 'vue';
import { useAuthStore } from './stores/auth';

const STORAGE_KEY = 'moj-n8n-theme';
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

/**
 * Shows the app in `theme`: sets `data-theme` on <html>, which picks the token set in `App.vue`
 * (`system` follows the operating system's light/dark setting). Also remembered on this device, so the
 * next start (and the sign-in page) opens in the same look before the account is read.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode, policies): the theme then only lasts until the page is reloaded.
  }
}

/** The theme last used on this device (`system` if none or unreadable). */
export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value as Theme) ? (value as Theme) : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Keeps the look in line with the signed-in user's saved theme (`settings.theme`): on sign-in, on
 * start, and whenever it changes. Signing out keeps the current look.
 */
export function watchUserTheme(): void {
  const auth = useAuthStore();
  watch(
    () => auth.user?.settings.theme,
    (theme) => {
      if (theme) applyTheme(theme);
    },
    { immediate: true },
  );
}
