/** Instance-wide role of a user (same values as n8n). */
export type GlobalRole = 'global:owner' | 'global:admin' | 'global:member';

/**
 * Role of a user inside one project; `personalOwner` exists only on personal projects. In a team project
 * `project:admin` is its one owner (UI: "Właściciel"): the creator, or whoever accepted a transfer.
 */
export type ProjectRole = 'project:personalOwner' | 'project:admin' | 'project:editor' | 'project:viewer';

/** The roles the owner can give other members of a team project. */
export type MemberRole = 'project:editor' | 'project:viewer';

export type ProjectType = 'personal' | 'team';

export type ProjectIcon = { type: 'emoji'; value: string };

export type Theme = 'system' | 'light' | 'dark';

/** Per-user preferences stored as JSON on the user row. */
export type UserSettings = { theme?: Theme };

/** The signed-in user as the API returns it (never contains password, 2FA secret or recovery codes). */
export type PublicUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: GlobalRole;
  mfaEnabled: boolean;
  settings: { theme: Theme };
  personalProjectId: string;
  /** How many team projects this account may own (its own limit, or the instance default). */
  teamProjectsLimit: number;
  /** How many team projects it owns now (`project:admin`); creating one more needs `owned < limit`. */
  ownedTeamProjects: number;
};

/**
 * Body of `POST /rest/signup`. `inviteToken` is the token of a project invitation or transfer link
 * mailed to `email`: with it that address may sign up even when signup is disabled (`SIGNUP_ENABLED=false`).
 */
export type SignupRequest = {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  inviteToken?: string;
};

/** A project as the signed-in user sees it in lists, with their own role in it. */
export type ProjectSummary = {
  id: string;
  name: string;
  type: ProjectType;
  icon: ProjectIcon | null;
  description: string | null;
  role: ProjectRole;
  memberCount: number;
};

export type ProjectMember = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: ProjectRole;
};

/** One project with its members (visible to every member, `project:viewer` included). */
export type ProjectDetails = ProjectSummary & { members: ProjectMember[] };

/**
 * An account as the owner/admin sees it on the Users page: account data only, never the user's
 * projects or their contents (privacy rule), never secrets.
 */
export type InstanceUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: GlobalRole;
  disabled: boolean;
  mfaEnabled: boolean;
  /** UTC day of the last authenticated request (`YYYY-MM-DD`), null if never. */
  lastActiveAt: string | null;
  /** Invited, has not accepted yet (no password). */
  isPending: boolean;
};

/** One page of `GET /rest/users`; `count` is the number of all matches. */
export type UserList = { count: number; items: InstanceUser[] };

/** Outcome per address of `POST /rest/invitations`. */
export type InvitationResult = { email: string; status: 'invited' | 'exists' };

/** `GET /rest/invitations/resolve`: whom the invitation is for and who sent it (null if that account is gone). */
export type InvitationInfo = { email: string; inviterName: string | null };

/** A pending invitation to a team project as its owner sees it (`GET /rest/projects/:id/invitations`). */
export type ProjectInvitation = {
  id: string;
  email: string;
  role: MemberRole;
  /** ISO timestamp; the link stops working then (7 days after it was sent). */
  expiresAt: string;
  createdAt: string;
};

/**
 * `POST /rest/projects/:id/invitations`: always this answer (and always a mail), whether or not the
 * address has an account — the owner never learns which addresses are registered.
 */
export type ProjectInvitationResult = { email: string; status: 'invited' };

/**
 * `GET /rest/project-invitations/resolve`: what the invitation link is for. `hasAccount` (an active
 * account with this email exists) tells the page whether to offer signing in or signing up;
 * `pendingInvite` (the address was invited to the platform and has not accepted yet) tells it to send
 * the visitor to that invitation mail first — signing up would fail. A disabled account is neither.
 * Only the holder of the link — the address' owner — sees them.
 */
export type ProjectInvitationInfo = {
  email: string;
  projectName: string;
  /** null once the inviting account is deleted. */
  inviterName: string | null;
  role: MemberRole;
  hasAccount: boolean;
  pendingInvite: boolean;
};

/** The pending transfer of a team project as its owner sees it (`GET /rest/projects/:id/transfer`). */
export type ProjectTransfer = { email: string; expiresAt: string; createdAt: string };

/** `POST /rest/projects/:id/transfer`: the same answer whether or not the address has an account. */
export type ProjectTransferResult = { email: string; expiresAt: string };

/** `GET /rest/project-transfers/resolve`: what the transfer link is for (see `ProjectInvitationInfo`). */
export type ProjectTransferInfo = {
  email: string;
  projectName: string;
  /** The sending owner (a transfer is deleted together with the sender's account, so never null). */
  fromName: string;
  hasAccount: boolean;
  pendingInvite: boolean;
};

/** A public API key as its owner sees it (`GET /rest/api-keys`): never the key itself. */
export type ApiKeySummary = {
  id: string;
  label: string;
  /** Last 4 characters of the key, so the user can tell keys apart. */
  hint: string;
  createdAt: string;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
  /** ISO timestamp of the last request with this key (updated at most once a minute), null if never. */
  lastUsedAt: string | null;
};

/** `POST /rest/api-keys`: the only response that ever contains the full key. */
export type CreatedApiKey = ApiKeySummary & { rawKey: string };

/**
 * `POST /rest/mfa/setup`: the TOTP secret (also inside the `otpauth://` URL for the QR code) and the
 * recovery codes. Shown to the user once; afterwards the server keeps only encrypted values.
 */
export type MfaSetup = { secret: string; otpauthUrl: string; recoveryCodes: string[] };

/** Body of every 4xx answer; `code` is a machine-readable reason (e.g. `MFA_REQUIRED_CODE`). */
export type ApiErrorBody = { message: string; code?: number };

/** `code` of "MFA required": the client should ask for the two-factor code (same value as n8n). */
export const MFA_REQUIRED_CODE = 998;

/** API keys one user may have at a time (`POST /rest/api-keys` answers 400 above it). */
export const API_KEYS_LIMIT = 10;

/** `GET /rest/resolve-password-token`: whether the reset page must also ask for the 2FA code. */
export type ResolvePasswordTokenResponse = { mfaRequired: boolean };

/**
 * 409 of `DELETE /rest/users/:id`: the account owns team projects. Only their number — the admin never
 * learns names or ids of other people's projects (privacy rule).
 */
export type DeleteUserConflict = ApiErrorBody & { projectCount: number };

/** A list answer of the public API (`/api/v1`). */
export type PublicApiList<T> = { data: T[] };
