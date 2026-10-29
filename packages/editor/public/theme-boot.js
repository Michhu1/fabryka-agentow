// Applies the theme last used on this device before the first paint, so a dark-theme user never sees
// a white flash while the app loads. A classic script file (not inline: the server's Content Security
// Policy allows only scripts from this site). Same storage key and values as `src/theme.ts`.
(() => {
  let theme = 'system';
  try {
    const stored = window.localStorage.getItem('moj-n8n-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
  } catch {
    // Storage blocked (private mode, policies): start with the system look.
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
