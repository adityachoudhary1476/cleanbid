/**
 * CleanBid Workspace Management Module
 * Handles workspace creation, switching, and membership.
 *
 * Authorization note: the UI MAY request a switch to any workspace id, but
 * the application must verify membership before honoring it. We never trust a
 * client-supplied workspace id for authorization — membership is confirmed
 * against the user's actual memberships (server-scoped via RLS in cloud mode).
 */

import { isCloud, getUserWorkspaces } from './auth.js';

/** Initialize the workspace module. */
export function initWorkspace() {
  console.log('[CleanBid] Workspace module initialized');
}

/** Get the current user's workspaces. */
export async function getWorkspaces() {
  return getUserWorkspaces();
}

/** Create a new workspace for the current user. */
export async function createNewWorkspace(name) {
  if (!name || !name.trim()) {
    throw new Error('Workspace name is required');
  }
  const { createWorkspace } = await import('./auth.js');
  return createWorkspace(name.trim());
}

/**
 * Verify the current user may switch to `workspaceId`.
 *
 * Returns the membership object (with role) when allowed, or null when the
 * user does not belong. In local/demo mode (no cloud, no membership table)
 * this returns a synthetic membership so local development switching works.
 */
export async function authorizeWorkspaceSwitch(workspaceId) {
  if (!workspaceId) return null;

  if (isCloud()) {
    const memberships = await getUserWorkspaces();
    const member = memberships.find((w) => w.id === workspaceId);
    return member || null;
  }

  // Local / demo mode: no server-side membership to validate against.
  return { id: workspaceId, role: 'owner' };
}

/** Dispatch a workspace switch request (the app shell handles authorization). */
export function switchWorkspace(workspaceId) {
  window.dispatchEvent(new CustomEvent('workspace:switch', { detail: { workspaceId } }));
}

/** Get current workspace info from the app shell's context. */
export function getCurrentWorkspace() {
  return window.__cleanbid_current_workspace || null;
}

/** Set current workspace info. */
export function setCurrentWorkspace(workspace) {
  window.__cleanbid_current_workspace = workspace;
}
