import { useI18n } from 'vue-i18n';
import { ApiError } from '../api/client';

/**
 * The one place that turns server error messages (English, see `packages/server`) into i18n keys. Keys
 * by exact `message`; a few messages carry a variable part and are matched by pattern. Anything unknown
 * becomes `common.unexpectedError`.
 */
const BY_MESSAGE: Record<string, string> = {
  Unauthorized: 'errors.sessionExpired',
  'Too many requests': 'errors.tooManyRequests',
  'Service unavailable': 'errors.serviceUnavailable',
  'Invalid JSON body': 'errors.invalidRequest',
  'Invalid request body': 'errors.invalidRequest',
  'Content-Type must be application/json': 'errors.invalidRequest',
  Forbidden: 'errors.forbidden',
  'Not found': 'errors.notFound',
  'Email already in use': 'errors.emailInUse',
  'Email is required': 'errors.emailRequired',
  'Invalid email address': 'errors.invalidEmail',
  'Password is required': 'errors.passwordRequired',
  'Password is too long': 'errors.passwordTooLong',
  'Password must be 8–64 characters and contain a number and an uppercase letter': 'errors.passwordPolicy',
  'First name is required': 'errors.firstNameRequired',
  'Last name is required': 'errors.lastNameRequired',
  'First name must be at most 32 characters': 'errors.firstNameTooLong',
  'Last name must be at most 32 characters': 'errors.lastNameTooLong',
  'Wrong username or password': 'errors.wrongCredentials',
  'MFA required': 'errors.mfaRequired',
  'Invalid two-factor code': 'errors.invalidMfaCode',
  'Two-factor code is required': 'errors.mfaCodeRequired',
  'Two-factor authentication is already enabled': 'errors.mfaAlreadyEnabled',
  'Two-factor authentication is not enabled': 'errors.mfaNotEnabled',
  'Set up two-factor authentication first': 'errors.mfaSetupFirst',
  'Signup is disabled': 'errors.signupDisabled',
  'Invalid password reset token': 'errors.invalidResetToken',
  'Invalid invitation token': 'errors.invalidInvitationToken',
  'Invalid transfer token': 'errors.invalidTransferToken',
  'Invalid invite token': 'errors.invalidInviteToken',
  'This invitation is for a different email address': 'errors.wrongInvitationEmail',
  'This transfer is for a different email address': 'errors.wrongTransferEmail',
  'User is already a member': 'errors.alreadyMember',
  'Team project limit reached': 'errors.teamProjectLimit',
  'Current password is incorrect': 'errors.currentPasswordIncorrect',
  'Current password is required': 'errors.currentPasswordRequired',
  'Project not found': 'errors.projectNotFound',
  'Member not found': 'errors.memberNotFound',
  'Invitation not found': 'errors.invitationNotFound',
  'Transfer not found': 'errors.transferNotFound',
  'User not found': 'errors.userNotFound',
  'API key not found': 'errors.apiKeyNotFound',
  'Name is required': 'errors.nameRequired',
  'Name must be at most 255 characters': 'errors.nameTooLong',
  'Description must be at most 512 characters': 'errors.descriptionTooLong',
  'Invalid icon': 'errors.invalidIcon',
  'Label is required': 'errors.labelRequired',
  'Label must be at most 100 characters': 'errors.labelTooLong',
  'expiresAt must be in the future': 'errors.expiresInPast',
  'Members of a personal project cannot be changed': 'errors.personalProjectNoMembers',
  'Only the icon of a personal project can be changed': 'errors.personalProjectIconOnly',
  'Personal project cannot be deleted': 'errors.personalProjectNoDelete',
  'Personal project cannot be transferred': 'errors.personalProjectNoTransfer',
  'You already own this project': 'errors.alreadyOwner',
  'The project owner cannot be removed or demoted': 'errors.ownerProtected',
  'The project owner cannot leave the project; transfer it first': 'errors.ownerCannotLeave',
  'You cannot change your own role': 'errors.ownRole',
  'The role of the owner cannot be changed': 'errors.ownerRole',
  'User owns team projects': 'errors.userOwnsProjects',
  'Role must be project:editor or project:viewer': 'errors.invalidProjectRole',
  'Role must be global:admin or global:member': 'errors.invalidGlobalRole',
  'Role must be global:member or global:admin': 'errors.invalidGlobalRole',
  'Theme must be system, light or dark': 'errors.invalidTheme',
  'At least one email is required': 'errors.emailsRequired',
  'At most 20 emails at once': 'errors.tooManyEmails',
};

const BY_PATTERN: [RegExp, string][] = [
  [/^API key limit reached/, 'errors.apiKeyLimit'],
  [/^You cannot \w+ your own account$/, 'errors.ownAccount'],
  [/^The owner cannot be \w+$/, 'errors.platformOwner'],
  // A field the server does not know (a client/server version mismatch, not the user's fault).
  [/^Unknown field: /, 'errors.invalidRequest'],
];

/** i18n key for any error thrown by an API call (or anything else). */
export function serverErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'common.unexpectedError';
  if (error.status === 0) return 'common.networkError';
  if (error.status === 429) return 'errors.tooManyRequests';
  const exact = BY_MESSAGE[error.message];
  if (exact) return exact;
  for (const [pattern, key] of BY_PATTERN) if (pattern.test(error.message)) return key;
  return 'common.unexpectedError';
}

/** `errorText(e)` → the Polish message for an error, for views and stores with a component context. */
export function useServerError(): (error: unknown) => string {
  const { t } = useI18n();
  return (error) => t(serverErrorKey(error));
}
