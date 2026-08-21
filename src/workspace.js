/**
 * CleanBid Workspace Management Module
 * Handles workspace creation, switching, and membership.
 */

import { createWorkspace, getUserWorkspaces } from './auth.js';

/**
 * Initialize the workspace module.
 */
export function initWorkspace() {
  console.log('[CleanBid] Workspace module initialized');
}

/**
 * Get the current user's workspaces.
 */
export async function getWorkspaces() {
  return await getUserWorkspaces();
}

/**
 * Create a new workspace for the current user.
 */
export async function createNewWorkspace(name) {
  if (!name || !name.trim()) {
    throw new Error('Workspace name is required');
  }
  return await createWorkspace(name.trim());
}

/**
 * Switch to a different workspace.
 */
export function switchWorkspace(workspaceId) {
  // This will be handled by the app shell
  window.dispatchEvent(new CustomEvent('workspace:switch', { detail: { workspaceId } }));
}

/**
 * Get current workspace info.
 */
export function getCurrentWorkspace() {
  return window.__cleanbid_current_workspace || null;
}

/**
 * Set current workspace info.
 */
export function setCurrentWorkspace(workspace) {
  window.__cleanbid_current_workspace = workspace;
}
