/**
 * CleanBid Main Entry Point
 * Initializes modules and bootstraps the application.
 */

import { initAuth } from './auth.js';
import { initDb } from './db.js';
import { initWorkspace } from './workspace.js';

/**
 * Initialize the application.
 */
export async function bootstrap() {
  console.log('[CleanBid] Bootstrapping...');

  // Initialize modules in order
  const cloudMode = await initAuth();
  const dbMode = await initDb();

  console.log(`[CleanBid] Auth mode: ${cloudMode ? 'cloud' : 'local'}`);
  console.log(`[CleanBid] DB mode: ${dbMode}`);

  // Load initial state
  const savedState = await window.__cleanbid_db.loadState();
  if (savedState) {
    window.__cleanbid_state = savedState;
  }

  // Initialize workspace
  initWorkspace();

  console.log('[CleanBid] Bootstrap complete');
}

/**
 * Check if user is authenticated.
 */
export function isAuthenticated() {
  const user = window.__cleanbid_user;
  const session = window.__cleanbid_auth?.getSession?.();
  return !!(user && session);
}
