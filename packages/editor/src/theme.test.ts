import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import appSource from './App.vue?raw';
import { useAuthStore } from './stores/auth';
import { publicUser } from './test/fixtures';
import { applyTheme, storedTheme, watchUserTheme } from './theme';

const html = () => document.documentElement;

describe('applyTheme', () => {
  afterEach(() => {
    html().removeAttribute('data-theme');
    localStorage.clear();
  });

  it('sets data-theme on <html>', () => {
    applyTheme('dark');
    expect(html().getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(html().getAttribute('data-theme')).toBe('light');
    applyTheme('system');
    expect(html().getAttribute('data-theme')).toBe('system');
  });

  it('remembers the theme on this device for the next start (before the user is known)', () => {
    expect(storedTheme()).toBe('system');
    applyTheme('dark');
    expect(storedTheme()).toBe('dark');
    localStorage.setItem('moj-n8n-theme', 'neon');
    expect(storedTheme()).toBe('system');
  });
});

describe('watchUserTheme', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    html().removeAttribute('data-theme');
    localStorage.clear();
  });

  it("applies the signed-in user's theme and follows changes; signing out keeps it", async () => {
    const auth = useAuthStore();
    watchUserTheme();
    auth.setUser(publicUser({ settings: { theme: 'dark' } }));
    await nextTick();
    expect(html().getAttribute('data-theme')).toBe('dark');
    auth.setUser(publicUser({ settings: { theme: 'light' } }));
    await nextTick();
    expect(html().getAttribute('data-theme')).toBe('light');
    auth.setUser(null);
    await nextTick();
    expect(html().getAttribute('data-theme')).toBe('light');
  });
});

describe('App.vue theme tokens', () => {
  /** The dark token set appears twice (forced dark, and dark system without forced light). */
  function darkBlocks(): [string, string] {
    const forced = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(appSource)?.[1];
    const system =
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(
        appSource,
      )?.[1];
    return [forced ?? '', system ?? ''];
  }

  it('every color and shadow token of the light set has a dark value', () => {
    const light = /:root\s*\{([^}]*)\}/.exec(appSource)?.[1] ?? '';
    const names = (block: string) => new Set(block.match(/--(?:color|shadow)-[\w-]+(?=:)/g) ?? []);
    const lightNames = names(light);
    const [forced] = darkBlocks();
    expect(lightNames.size).toBeGreaterThan(30);
    expect([...lightNames].filter((name) => !names(forced ?? '').has(name))).toEqual([]);
  });

  it('the forced-dark and system-dark token sets are identical', () => {
    const [forced, system] = darkBlocks();
    expect(forced).toContain('--color-bg');
    expect(forced?.replace(/\s+/g, ' ').trim()).toBe(system.replace(/\s+/g, ' ').trim());
  });
});

describe('public/theme-boot.js (runs before the app, before the first paint)', () => {
  afterEach(() => {
    html().removeAttribute('data-theme');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function runBootScript() {
    const source = (await import('../public/theme-boot.js?raw')).default as string;
    new Function(source)();
  }

  it('applies what applyTheme stored on this device', async () => {
    applyTheme('dark');
    html().removeAttribute('data-theme');
    await runBootScript();
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  it('nothing stored, a bad value or blocked storage → system', async () => {
    await runBootScript();
    expect(html().getAttribute('data-theme')).toBe('system');
    localStorage.setItem('moj-n8n-theme', 'neon');
    await runBootScript();
    expect(html().getAttribute('data-theme')).toBe('system');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await runBootScript();
    expect(html().getAttribute('data-theme')).toBe('system');
  });

  it('index.html loads it as a classic script in <head> (no inline script: CSP)', async () => {
    const index = (await import('../index.html?raw')).default as string;
    const head = index.slice(0, index.indexOf('</head>'));
    expect(head).toContain('<script src="/theme-boot.js"></script>');
  });
});
