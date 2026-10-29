<script setup lang="ts">
import { MFA_REQUIRED_CODE, type PublicUser, type Theme } from '@app/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, apiClient } from '../../api/client';
import PageLayout from '../../components/PageLayout.vue';
import SettingsSection from '../../components/SettingsSection.vue';
import MfaDisableDialog from '../../components/settings/MfaDisableDialog.vue';
import MfaSetupDialog from '../../components/settings/MfaSetupDialog.vue';
import AppAlert from '../../components/ui/AppAlert.vue';
import AppButton from '../../components/ui/AppButton.vue';
import AppFormError from '../../components/ui/AppFormError.vue';
import AppInput from '../../components/ui/AppInput.vue';
import { globalRoleKey } from '../../i18n';
import { useServerError } from '../../i18n/server-errors';
import { useAuthStore } from '../../stores/auth';
import { applyTheme } from '../../theme';
import { meetsPasswordPolicy } from '../../utils/password';

/**
 * Settings → Osobiste (n8n: Personal): name, email (with the current password, and the 2FA code when
 * 2FA is on), password, two-factor authentication and the theme. Every answer that returns the user
 * updates the auth store, so the rest of the app (e.g. "Przekaż projekt" asking for a 2FA code) follows.
 * A wrong current password is a form error here, never a sign-out (see `isSessionExpired`).
 */
const { t } = useI18n();
const auth = useAuthStore();
const errorText = useServerError();

const mfaEnabled = computed(() => !!auth.user?.mfaEnabled);

// --- Profile ---------------------------------------------------------------------------------------
const firstName = ref(auth.user?.firstName ?? '');
const lastName = ref(auth.user?.lastName ?? '');
const profileSaving = ref(false);
const profileSaved = ref(false);
const profileError = ref<string | null>(null);
const profileDirty = computed(
  () => firstName.value !== (auth.user?.firstName ?? '') || lastName.value !== (auth.user?.lastName ?? ''),
);
watch(profileDirty, (dirty) => {
  if (dirty) profileSaved.value = false;
});

function resetProfile() {
  firstName.value = auth.user?.firstName ?? '';
  lastName.value = auth.user?.lastName ?? '';
  profileError.value = null;
}

async function saveProfile() {
  profileError.value = null;
  if (!firstName.value.trim()) {
    profileError.value = t('errors.firstNameRequired');
    return;
  }
  if (!lastName.value.trim()) {
    profileError.value = t('errors.lastNameRequired');
    return;
  }
  profileSaving.value = true;
  try {
    auth.setUser(
      await apiClient.patch<PublicUser>('/rest/me', {
        firstName: firstName.value.trim(),
        lastName: lastName.value.trim(),
      }),
    );
    resetProfile();
    profileSaved.value = true;
  } catch (caught) {
    profileError.value = errorText(caught);
  } finally {
    profileSaving.value = false;
  }
}

// --- Email -----------------------------------------------------------------------------------------
const newEmail = ref('');
const emailPassword = ref('');
const emailMfaCode = ref('');
/** 2FA turned on elsewhere since the user was read: the server's "MFA required" shows the field. */
const emailMfaAsked = ref(false);
const emailNeedsMfa = computed(() => mfaEnabled.value || emailMfaAsked.value);
const emailSaving = ref(false);
const emailError = ref<string | null>(null);
const emailChanged = ref<string | null>(null);

async function changeEmail() {
  emailError.value = null;
  emailChanged.value = null;
  const email = newEmail.value.trim();
  if (!email) {
    emailError.value = t('errors.emailRequired');
    return;
  }
  if (email.toLowerCase() === auth.user?.email) {
    emailError.value = t('settings.personal.email.same');
    return;
  }
  if (!emailPassword.value) {
    emailError.value = t('errors.currentPasswordRequired');
    return;
  }
  emailSaving.value = true;
  try {
    // A new session cookie comes with the answer (the old session ended with the old address).
    const user = await apiClient.patch<PublicUser>('/rest/me', {
      email,
      currentPassword: emailPassword.value,
      ...(emailNeedsMfa.value ? { mfaCode: emailMfaCode.value.replace(/\s/g, '') } : {}),
    });
    auth.setUser(user);
    emailChanged.value = t('settings.personal.email.changed', { email: user.email });
    newEmail.value = '';
    emailPassword.value = '';
    emailMfaCode.value = '';
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === MFA_REQUIRED_CODE) emailMfaAsked.value = true;
    emailError.value = errorText(caught);
  } finally {
    emailSaving.value = false;
  }
}

// --- Password --------------------------------------------------------------------------------------
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordMfaCode = ref('');
const passwordMfaAsked = ref(false);
const passwordNeedsMfa = computed(() => mfaEnabled.value || passwordMfaAsked.value);
const newPasswordError = ref<string | undefined>();
const confirmError = ref<string | undefined>();
const passwordSaving = ref(false);
const passwordError = ref<string | null>(null);
const passwordChanged = ref(false);

async function changePassword() {
  passwordError.value = null;
  passwordChanged.value = false;
  newPasswordError.value = undefined;
  confirmError.value = undefined;
  if (!currentPassword.value) {
    passwordError.value = t('errors.currentPasswordRequired');
    return;
  }
  if (!meetsPasswordPolicy(newPassword.value)) {
    newPasswordError.value = t('errors.passwordPolicy');
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    confirmError.value = t('auth.passwordMismatch');
    return;
  }
  passwordSaving.value = true;
  try {
    // Other devices are signed out; this one gets a new session cookie with the answer.
    auth.setUser(
      await apiClient.patch<PublicUser>('/rest/me/password', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        ...(passwordNeedsMfa.value ? { mfaCode: passwordMfaCode.value.replace(/\s/g, '') } : {}),
      }),
    );
    passwordChanged.value = true;
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    passwordMfaCode.value = '';
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === MFA_REQUIRED_CODE) passwordMfaAsked.value = true;
    passwordError.value = errorText(caught);
  } finally {
    passwordSaving.value = false;
  }
}

// --- Two-factor authentication ---------------------------------------------------------------------
const setupOpen = ref(false);
const disableOpen = ref(false);
const mfaNotice = ref<'enabled' | 'disabled' | null>(null);

// --- Theme -----------------------------------------------------------------------------------------
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
/** The theme saved in the account. */
const savedTheme = computed<Theme>(() => auth.user?.settings.theme ?? 'system');
/** The checked radio: the user's latest choice, put back to `savedTheme` if saving it fails. */
const selectedTheme = ref<Theme>(savedTheme.value);
const themeSaving = ref(false);
const themeError = ref<string | null>(null);
/** Number of the latest save: only its answer counts (quick arrow-key steps send several). */
let themeRequest = 0;

// Changed elsewhere (another tab, a re-read user) while nothing is being saved here: follow it.
watch(savedTheme, (saved) => {
  if (!themeSaving.value) selectedTheme.value = saved;
});

async function setTheme(next: Theme) {
  selectedTheme.value = next;
  themeError.value = null;
  // Shown at once; the saved value comes back with the user (and `watchUserTheme` keeps it applied).
  applyTheme(next);
  const request = ++themeRequest;
  themeSaving.value = true;
  try {
    const user = await apiClient.patch<PublicUser>('/rest/me/settings', { theme: next });
    if (request !== themeRequest) return;
    auth.setUser(user);
  } catch (caught) {
    if (request !== themeRequest) return;
    selectedTheme.value = savedTheme.value;
    applyTheme(savedTheme.value);
    themeError.value = errorText(caught);
  } finally {
    if (request === themeRequest) themeSaving.value = false;
  }
}
</script>

<template>
  <PageLayout :title="t('settings.personal.title')" :subtitle="t('settings.personal.subtitle')">
    <template v-if="auth.user">
      <SettingsSection :title="t('settings.personal.profile.title')">
        <form class="personal__form" novalidate data-test="profile-form" @submit.prevent="saveProfile">
          <div class="personal__row">
            <AppInput
              v-model="firstName"
              class="personal__grow"
              :label="t('common.firstName')"
              autocomplete="given-name"
              :maxlength="32"
              required
              data-test="first-name"
            />
            <AppInput
              v-model="lastName"
              class="personal__grow"
              :label="t('common.lastName')"
              autocomplete="family-name"
              :maxlength="32"
              required
              data-test="last-name"
            />
          </div>
          <p class="personal__muted">
            {{ t('settings.personal.profile.role', { role: t(globalRoleKey(auth.user.role)) }) }}
          </p>
          <AppFormError :message="profileError" />
          <AppAlert v-if="profileSaved" variant="success">{{ t('common.saved') }}</AppAlert>
          <div class="personal__actions">
            <AppButton variant="secondary" :disabled="!profileDirty || profileSaving" @click="resetProfile">
              {{ t('common.cancel') }}
            </AppButton>
            <AppButton type="submit" :disabled="!profileDirty" :loading="profileSaving" data-test="profile-save">
              {{ t('common.save') }}
            </AppButton>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection :title="t('settings.personal.email.title')" :description="t('settings.personal.email.description')">
        <p class="personal__current">{{ t('settings.personal.email.current', { email: auth.user.email }) }}</p>
        <form class="personal__form" novalidate data-test="email-form" @submit.prevent="changeEmail">
          <AppInput
            v-model="newEmail"
            type="email"
            autocomplete="email"
            :label="t('settings.personal.email.new')"
            required
            data-test="new-email"
          />
          <AppInput
            v-model="emailPassword"
            type="password"
            autocomplete="current-password"
            :label="t('settings.personal.email.password')"
            :hint="t('settings.personal.email.passwordHint')"
            required
            data-test="email-password"
          />
          <AppInput
            v-if="emailNeedsMfa"
            v-model="emailMfaCode"
            inputmode="numeric"
            autocomplete="one-time-code"
            :label="t('settings.personal.email.mfaCode')"
            :hint="t('settings.personal.email.mfaHint')"
            :maxlength="7"
            required
            data-test="email-mfa"
          />
          <AppFormError :message="emailError" />
          <AppAlert v-if="emailChanged" variant="success">{{ emailChanged }}</AppAlert>
          <div class="personal__actions">
            <AppButton type="submit" :loading="emailSaving" data-test="email-save">
              {{ t('settings.personal.email.submit') }}
            </AppButton>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection :title="t('settings.personal.password.title')" :description="t('settings.personal.password.description')">
        <form class="personal__form" novalidate data-test="password-form" @submit.prevent="changePassword">
          <AppInput
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            :label="t('settings.personal.password.current')"
            required
            data-test="current-password"
          />
          <AppInput
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            :label="t('settings.personal.password.new')"
            :hint="t('auth.passwordHint')"
            :error="newPasswordError"
            required
            data-test="new-password"
          />
          <AppInput
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :label="t('settings.personal.password.confirm')"
            :error="confirmError"
            required
            data-test="confirm-password"
          />
          <AppInput
            v-if="passwordNeedsMfa"
            v-model="passwordMfaCode"
            inputmode="numeric"
            autocomplete="one-time-code"
            :label="t('settings.personal.email.mfaCode')"
            :hint="t('settings.personal.email.mfaHint')"
            :maxlength="7"
            required
            data-test="password-mfa"
          />
          <AppFormError :message="passwordError" />
          <AppAlert v-if="passwordChanged" variant="success">{{ t('settings.personal.password.changed') }}</AppAlert>
          <div class="personal__actions">
            <AppButton type="submit" :loading="passwordSaving" data-test="password-save">
              {{ t('settings.personal.password.submit') }}
            </AppButton>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection :title="t('settings.personal.mfa.title')" :description="t('settings.personal.mfa.description')">
        <p class="personal__status" data-test="mfa-status">
          {{ t('settings.personal.mfa.status') }}
          <span class="personal__badge" :class="mfaEnabled ? 'personal__badge--on' : 'personal__badge--off'">
            {{ mfaEnabled ? t('settings.personal.mfa.on') : t('settings.personal.mfa.off') }}
          </span>
        </p>
        <AppAlert v-if="mfaNotice === 'enabled'" variant="success">{{ t('settings.personal.mfa.enabled') }}</AppAlert>
        <AppAlert v-else-if="mfaNotice === 'disabled'" variant="info">{{ t('settings.personal.mfa.disabled') }}</AppAlert>
        <div>
          <AppButton v-if="!mfaEnabled" data-test="mfa-enable-open" @click="(mfaNotice = null), (setupOpen = true)">
            {{ t('settings.personal.mfa.enable') }}
          </AppButton>
          <AppButton v-else variant="secondary" data-test="mfa-disable-open" @click="(mfaNotice = null), (disableOpen = true)">
            {{ t('settings.personal.mfa.disable') }}
          </AppButton>
        </div>
        <MfaSetupDialog v-model:open="setupOpen" @enabled="mfaNotice = 'enabled'" />
        <MfaDisableDialog v-model:open="disableOpen" @disabled="mfaNotice = 'disabled'" />
      </SettingsSection>

      <SettingsSection :title="t('settings.personal.theme.title')" :description="t('settings.personal.theme.description')">
        <!-- Never `disabled` while saving: that would drop keyboard focus on every arrow-key step. -->
        <fieldset class="personal__themes" :aria-busy="themeSaving" data-test="theme">
          <legend class="visually-hidden">{{ t('settings.personal.theme.label') }}</legend>
          <label
            v-for="option in THEMES"
            :key="option"
            class="personal__theme"
            :class="{ 'personal__theme--checked': selectedTheme === option }"
          >
            <input
              v-model="selectedTheme"
              type="radio"
              name="theme"
              class="personal__radio"
              :value="option"
              :data-test="`theme-${option}`"
              @change="setTheme(option)"
            />
            <span class="personal__swatch" :class="`personal__swatch--${option}`" aria-hidden="true" />
            {{ t(`settings.personal.theme.${option}`) }}
          </label>
        </fieldset>
        <AppFormError :message="themeError" />
      </SettingsSection>
    </template>
  </PageLayout>
</template>

<style scoped>
.personal__form {
  display: grid;
  gap: var(--space-4);
  max-width: 480px;
}
.personal__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.personal__grow {
  flex: 1 1 180px;
}
.personal__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: var(--space-2);
}
.personal__muted,
.personal__current,
.personal__status {
  margin: 0;
}
.personal__muted {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.personal__current {
  font-weight: var(--font-weight-medium);
  overflow-wrap: anywhere;
}
.personal__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.personal__badge {
  padding: 2px var(--space-2);
  border: var(--border-width) solid;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}
.personal__badge--on {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success);
}
.personal__badge--off {
  background: var(--color-surface-muted);
  border-color: var(--color-border);
  color: var(--color-text-muted);
}
.personal__themes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  border: none;
}
.personal__theme {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 140px;
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  cursor: pointer;
}
.personal__theme:hover {
  background: var(--color-surface-muted);
}
.personal__theme--checked {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary);
}
.personal__theme:has(.personal__radio:focus-visible) {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.personal__radio {
  margin: 0;
  accent-color: var(--color-primary);
}
.personal__swatch {
  width: 20px;
  height: 20px;
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: 50%;
}
.personal__swatch--light {
  background: var(--color-swatch-light);
}
.personal__swatch--dark {
  background: var(--color-swatch-dark);
}
.personal__swatch--system {
  background: linear-gradient(135deg, var(--color-swatch-light) 50%, var(--color-swatch-dark) 50%);
}
</style>
