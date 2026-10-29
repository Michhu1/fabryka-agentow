import type {
  MemberRole,
  ProjectDetails,
  ProjectIcon,
  ProjectInvitation,
  ProjectInvitationResult,
  ProjectSummary,
  ProjectTransfer,
  ProjectTransferResult,
} from '@app/shared';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { ApiError, apiClient } from '../api/client';
import { useAuthStore } from './auth';

export type ProjectInput = { name: string; icon?: ProjectIcon | null; description?: string | null };
export type ProjectPatch = Partial<ProjectInput>;
/** Confirmation of a transfer: the 2FA code when 2FA is on, the current password otherwise. */
export type TransferInput = { email: string; currentPassword?: string; mfaCode?: string };

/** Same collation as the server (`project-service.ts`): "Łódź" after "Lublin", not after "Zebra". */
const collator = new Intl.Collator('pl');

/** The server's order of `my-projects`: the personal project first, then by name, ties by id. */
export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort(
    (a, b) =>
      Number(b.type === 'personal') - Number(a.type === 'personal') ||
      collator.compare(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function toSummary(project: ProjectSummary): ProjectSummary {
  const { id, name, type, icon, description, role, memberCount } = project;
  return { id, name, type, icon, description, role, memberCount };
}

/** The server's answer for a project that is gone for the caller (deleted, or no longer a member). */
export function isProjectGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.message === 'Project not found';
}

/** Whether the user owns this team project (what `ownedTeamProjects` counts). */
const ownsTeam = (project: ProjectSummary | undefined) =>
  project?.type === 'team' && project.role === 'project:admin';

const base = (projectId: string) => `/rest/projects/${encodeURIComponent(projectId)}`;

/**
 * The signed-in user's projects (`myProjects`, the sidebar and the overview read it) and every call of
 * the project pages. Calls that change which projects the user owns (create, delete) re-read the user,
 * whose `ownedTeamProjects` / `teamProjectsLimit` drive the "Projekty: X z Y" counter.
 */
export const useProjectsStore = defineStore('projects', () => {
  const auth = useAuthStore();
  const myProjects = ref<ProjectSummary[]>([]);
  const loaded = ref(false);
  let loading: Promise<void> | null = null;

  const personalProject = computed(() => myProjects.value.find((p) => p.type === 'personal') ?? null);
  const teamProjects = computed(() => myProjects.value.filter((p) => p.type === 'team'));

  // Another account signed in (or signed out): never show the previous user's projects.
  watch(
    () => auth.user?.id,
    (next, previous) => {
      if (next === previous) return;
      myProjects.value = [];
      loaded.value = false;
      loading = null;
    },
    { flush: 'sync' },
  );

  /** Re-reads the user (owned/limit counters); a failure only leaves the counter as it was. */
  async function refreshUser(): Promise<void> {
    await auth.refresh().catch(() => undefined);
  }

  /**
   * Puts the project's latest summary into the list. If the user became or stopped being its owner
   * meanwhile (a transfer accepted elsewhere), the user is re-read, so "Projekty: X z Y" stays right.
   */
  function upsert(project: ProjectSummary): void {
    const previous = myProjects.value.find((p) => p.id === project.id);
    const others = myProjects.value.filter((p) => p.id !== project.id);
    myProjects.value = sortProjects([...others, toSummary(project)]);
    if (previous && ownsTeam(previous) !== ownsTeam(project)) void refreshUser();
  }

  /** Removes the project from the list; an owned one changes the counter, so the user is re-read. */
  function drop(projectId: string): Promise<void> {
    const previous = myProjects.value.find((p) => p.id === projectId);
    myProjects.value = myProjects.value.filter((p) => p.id !== projectId);
    return ownsTeam(previous) ? refreshUser() : Promise.resolve();
  }

  /** Runs a call about one project; a 404 "Project not found" also drops it from the list. */
  async function about<T>(projectId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isProjectGone(error)) void drop(projectId);
      throw error;
    }
  }

  async function load(): Promise<void> {
    const userId = auth.user?.id;
    const list = await apiClient.get<ProjectSummary[]>('/rest/projects/my-projects');
    // Another account signed in while this was on its way: the list is not theirs.
    if (auth.user?.id !== userId) return;
    myProjects.value = list.map(toSummary);
    loaded.value = true;
    // The counter comes from the user; a transfer accepted elsewhere changes what this list shows first.
    const owned = list.filter((p) => p.type === 'team' && p.role === 'project:admin').length;
    if (auth.user && owned !== auth.user.ownedTeamProjects) await refreshUser();
  }

  /** Loads the list once (the sidebar and the overview both ask); concurrent calls share the request. */
  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    loading ??= load().finally(() => {
      loading = null;
    });
    return loading;
  }

  /** One project with its members; a 404 (deleted, or no longer a member) drops it from the list. */
  async function get(projectId: string): Promise<ProjectDetails> {
    try {
      const project = await apiClient.get<ProjectDetails>(base(projectId));
      upsert(project);
      return project;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) void drop(projectId);
      throw error;
    }
  }

  async function create(input: ProjectInput): Promise<ProjectDetails> {
    try {
      const project = await apiClient.post<ProjectDetails>('/rest/projects', input);
      upsert(project);
      return project;
    } finally {
      // Also after "Team project limit reached": the counter then catches up with the server.
      await refreshUser();
    }
  }

  async function update(projectId: string, patch: ProjectPatch): Promise<ProjectDetails> {
    const project = await about(projectId, () => apiClient.patch<ProjectDetails>(base(projectId), patch));
    upsert(project);
    return project;
  }

  async function remove(projectId: string): Promise<void> {
    await about(projectId, () => apiClient.delete(base(projectId)));
    const owned = ownsTeam(myProjects.value.find((p) => p.id === projectId));
    await drop(projectId);
    // Not in the list (never loaded): the counter may still have changed.
    if (!owned) await refreshUser();
  }

  async function updateMember(projectId: string, userId: string, role: MemberRole): Promise<ProjectDetails> {
    const project = await about(projectId, () =>
      apiClient.patch<ProjectDetails>(`${base(projectId)}/members/${encodeURIComponent(userId)}`, { role }),
    );
    upsert(project);
    return project;
  }

  /** Removes another member (owner only) and returns the project as it is now. */
  async function removeMember(projectId: string, userId: string): Promise<ProjectDetails> {
    await about(projectId, () =>
      apiClient.delete(`${base(projectId)}/members/${encodeURIComponent(userId)}`),
    );
    return get(projectId);
  }

  /** The signed-in member leaves the project (the owner cannot: 409, transfer it first). */
  async function leave(projectId: string): Promise<void> {
    const userId = auth.user?.id;
    if (!userId) return;
    await about(projectId, () =>
      apiClient.delete(`${base(projectId)}/members/${encodeURIComponent(userId)}`),
    );
    await drop(projectId);
  }

  function invitations(projectId: string): Promise<ProjectInvitation[]> {
    return about(projectId, () => apiClient.get<ProjectInvitation[]>(`${base(projectId)}/invitations`));
  }

  function invite(projectId: string, email: string, role: MemberRole): Promise<ProjectInvitationResult> {
    return about(projectId, () =>
      apiClient.post<ProjectInvitationResult>(`${base(projectId)}/invitations`, { email, role }),
    );
  }

  async function cancelInvitation(projectId: string, invitationId: string): Promise<void> {
    await about(projectId, () =>
      apiClient.delete(`${base(projectId)}/invitations/${encodeURIComponent(invitationId)}`),
    );
  }

  function transfer(projectId: string): Promise<ProjectTransfer | null> {
    return about(projectId, () => apiClient.get<ProjectTransfer | null>(`${base(projectId)}/transfer`));
  }

  function requestTransfer(projectId: string, input: TransferInput): Promise<ProjectTransferResult> {
    return about(projectId, () =>
      apiClient.post<ProjectTransferResult>(`${base(projectId)}/transfer`, input),
    );
  }

  async function cancelTransfer(projectId: string): Promise<void> {
    await about(projectId, () => apiClient.delete(`${base(projectId)}/transfer`));
  }

  return {
    myProjects,
    loaded,
    personalProject,
    teamProjects,
    load,
    ensureLoaded,
    get,
    create,
    update,
    remove,
    updateMember,
    removeMember,
    leave,
    invitations,
    invite,
    cancelInvitation,
    transfer,
    requestTransfer,
    cancelTransfer,
  };
});
