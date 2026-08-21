/**
 * CleanBid Migration Module
 * Handles migration from localStorage to Supabase.
 * 
 * IMPORTANT: Migration is EXPLICIT and USER-INITIATED only.
 * Never silently migrate, merge, overwrite, or delete local data.
 */

import { loadStateFromLocal, saveStateToSupabase, setCurrentWorkspaceId } from './db.js';
import { isCloud } from './auth.js';

/**
 * Check if there is local data available for migration.
 */
export function checkLocalData() {
  const localState = loadStateFromLocal();
  if (!localState) {
    return { hasLocalData: false };
  }

  return {
    hasLocalData: true,
    customerCount: (localState.customers || []).length,
    propertyCount: (localState.properties || []).length,
    quoteCount: (localState.quotes || []).length,
    profileCount: (localState.profiles || []).length,
  };
}

/**
 * Validate local data before migration.
 */
export function validateLocalData(localState) {
  const errors = [];

  if (!localState.customers || !Array.isArray(localState.customers)) {
    errors.push('Invalid customers data');
  }
  if (!localState.properties || !Array.isArray(localState.properties)) {
    errors.push('Invalid properties data');
  }
  if (!localState.quotes || !Array.isArray(localState.quotes)) {
    errors.push('Invalid quotes data');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Migrate local data to Supabase.
 * 
 * This function:
 * 1. Validates local data
 * 2. Transforms to Supabase schema
 * 3. Inserts with workspace_id
 * 4. Returns a summary
 * 
 * It does NOT delete local data. That requires explicit confirmation.
 */
export async function migrateLocalToSupabase(localState, workspaceId) {
  if (!isCloud()) {
    throw new Error('Migration requires Supabase to be configured');
  }

  const validation = validateLocalData(localState);
  if (!validation.valid) {
    throw new Error(`Invalid local data: ${validation.errors.join(', ')}`);
  }

  setCurrentWorkspaceId(workspaceId);
  await saveStateToSupabase(localState);

  return {
    success: true,
    customersMigrated: (localState.customers || []).length,
    propertiesMigrated: (localState.properties || []).length,
    quotesMigrated: (localState.quotes || []).length,
    profilesMigrated: (localState.profiles || []).length,
  };
}

/**
 * Clear local data AFTER successful migration and explicit confirmation.
 */
export function clearLocalData() {
  localStorage.removeItem('cleanbid_v3');
  console.log('[CleanBid Migration] Local data cleared');
}
