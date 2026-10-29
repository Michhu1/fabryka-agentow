const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where the desktop window points. APP_URL wins (e.g. the cloud address);
 * otherwise the Vite dev server in development, or the local app server when packaged.
 * A packaged app only talks to remote servers over https.
 */
export function resolveAppUrl(env: Record<string, string | undefined>, isPackaged: boolean): string {
  if (env.APP_URL) {
    const url = new URL(env.APP_URL);
    if (isPackaged && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(`APP_URL must use https for remote servers (got ${url.protocol}//${url.hostname})`);
    }
    return env.APP_URL;
  }
  return isPackaged ? 'http://localhost:5680' : 'http://localhost:5681';
}
