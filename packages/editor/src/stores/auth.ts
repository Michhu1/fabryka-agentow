import type { PublicUser, SignupRequest } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError, apiClient, isSessionExpired, onSessionExpired } from '../api/client';

export type MfaInput = { mfaCode?: string; mfaRecoveryCode?: string };

/**
 * The signed-in user. `initialized` turns true after the first `init()`, whatever its outcome; the
 * router waits for it before deciding where a visitor may go.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<PublicUser | null>(null);
  const initialized = ref(false);
  /** The last sign-out was the user's own "Wyloguj się" (not an expired session). */
  const signedOutByUser = ref(false);
  /**
   * The first read of the session failed for another reason than "not signed in" (server unreachable,
   * 5xx): the app shows "Nie można połączyć się z serwerem" instead of sign-in, with `retry()`.
   */
  const offline = ref(false);
  const isSignedIn = computed(() => user.value !== null);
  /** No more team projects for this user (the "Nowy projekt" buttons are off; with no user, too). */
  const atTeamProjectLimit = computed(
    () => (user.value?.ownedTeamProjects ?? 0) >= (user.value?.teamProjectsLimit ?? 0),
  );
  let initializing: Promise<void> | null = null;

  // Any API answer meaning "the session is gone" signs the user out here (the app then shows sign-in).
  onSessionExpired(() => {
    signedOutByUser.value = false;
    user.value = null;
  });

  /** Reads the current session once (`GET /rest/login`); concurrent calls share one request. */
  function init(): Promise<void> {
    if (initialized.value) return Promise.resolve();
    initializing ??= apiClient
      .get<PublicUser>('/rest/login')
      .then((current) => {
        user.value = current;
        offline.value = false;
      })
      .catch((error: unknown) => {
        user.value = null;
        // Only a 401 means "not signed in"; anything else means we do not know yet.
        offline.value = !(error instanceof ApiError && error.status === 401);
      })
      .finally(() => {
        initialized.value = true;
        initializing = null;
      });
    return initializing;
  }

  /** "Spróbuj ponownie" of the offline screen: reads the session again (`offline` tells the outcome). */
  function retry(): Promise<void> {
    if (initializing) return initializing;
    initialized.value = false;
    return init();
  }

  /** Re-reads the user after something changed it on the server (e.g. a project transfer accepted). */
  async function refresh(): Promise<void> {
    try {
      user.value = await apiClient.get<PublicUser>('/rest/login');
      offline.value = false;
    } catch (error) {
      if (isSessionExpired(error)) user.value = null;
      else throw error;
    } finally {
      initialized.value = true;
    }
  }

  /** For answers that return the user and set a new session cookie (password reset, invitation). */
  function setUser(next: PublicUser | null): void {
    if (next) signedOutByUser.value = false;
    user.value = next;
    offline.value = false;
    initialized.value = true;
  }

  /** Throws `ApiError`; `code === MFA_REQUIRED_CODE` (@app/shared) means: ask for the 2FA code and call again. */
  async function login(email: string, password: string, mfa: MfaInput = {}): Promise<PublicUser> {
    const signedIn = await apiClient.post<PublicUser>('/rest/login', { email, password, ...mfa });
    setUser(signedIn);
    return signedIn;
  }

  async function signup(input: SignupRequest): Promise<PublicUser> {
    const created = await apiClient.post<PublicUser>('/rest/signup', input);
    setUser(created);
    return created;
  }

  /** Signs out locally even if the server cannot be reached (the cookie is httpOnly). */
  async function logout(): Promise<void> {
    try {
      await apiClient.post('/rest/logout');
    } catch {
      // Ignored: the session ends on this device either way.
    } finally {
      signedOutByUser.value = true;
      user.value = null;
    }
  }

  return {
    user,
    initialized,
    signedOutByUser,
    offline,
    isSignedIn,
    atTeamProjectLimit,
    init,
    retry,
    refresh,
    setUser,
    login,
    signup,
    logout,
  };
});
