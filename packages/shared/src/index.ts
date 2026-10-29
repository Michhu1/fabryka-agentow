/** Working name of the product; renamed once the final name is chosen. */
export const APP_NAME = 'moj-n8n';

/** Kept in sync with the root package.json version (guarded by a test). */
export const APP_VERSION = '0.0.0';

export type {
  ApiErrorBody,
  ApiKeySummary,
  CreatedApiKey,
  DeleteUserConflict,
  GlobalRole,
  InstanceUser,
  InvitationInfo,
  InvitationResult,
  MemberRole,
  MfaSetup,
  ProjectDetails,
  ProjectIcon,
  ProjectInvitation,
  ProjectInvitationInfo,
  ProjectInvitationResult,
  ProjectMember,
  ProjectRole,
  ProjectSummary,
  ProjectTransfer,
  ProjectTransferInfo,
  ProjectTransferResult,
  ProjectType,
  PublicApiList,
  PublicUser,
  ResolvePasswordTokenResponse,
  SignupRequest,
  Theme,
  UserList,
  UserSettings,
} from './api.js';
export { API_KEYS_LIMIT, MFA_REQUIRED_CODE } from './api.js';
