/**
 * CleanBid Data Access Layer
 *
 * Dual-mode: local (localStorage) or Supabase (cloud).
 *
 * IMPORTANT RULES:
 * 1. Never silently fall back from authenticated cloud mode to localStorage.
 * 2. In local mode, state is namespaced per workspace id.
 * 3. In cloud mode, workspace_id comes from the authenticated session / the
 *    active workspace, and every query is scoped by workspace_id (RLS enforces
 *    this server-side; the client never authorizes by id alone).
 * 4. All write operations are debounced in cloud mode to avoid excessive API calls.
 */

import { isCloud, getCurrentUser, getUserWorkspaces } from './auth.js';
import { workspaceStorageKey, defaultWorkspaceData } from './state.js';
import { supabase } from './supabase.js';

const LOCAL_STORAGE_KEY = 'cleanbid_v3';
const DEMO_STORAGE_KEY = 'cleanbid_demo_v3';

let dbMode = null; // 'local' | 'supabase' | null (uninitialized)
let currentWorkspaceId = null;
let saveTimeout = null;

/**
 * Local storage is namespaced per workspace so that a switch never reads
 * another workspace's blob. A null/empty currentWorkspaceId maps to the
 * legacy shared key (single-workspace local mode + migration compatibility).
 */
function localStoreKey() {
  return workspaceStorageKey(LOCAL_STORAGE_KEY, currentWorkspaceId);
}

/**
 * Initialize the database layer.
 */
export async function initDb() {
  if (dbMode !== null) return dbMode;

  if (isCloud() && supabase) {
    try {
      // Pick an initial active workspace: prefer a saved preference that is
      // still one of the user's memberships; otherwise the first membership.
      const workspaces = await getUserWorkspaces();
      const saved = safeGetActivePref();
      const active = workspaces.find((w) => w.id === saved) || workspaces[0];
      if (active) currentWorkspaceId = active.id;

      dbMode = 'supabase';
      console.log('[CleanBid DB] Initialized in Supabase mode');
      return dbMode;
    } catch (error) {
      console.error('[CleanBid DB] Failed to initialize Supabase:', error);
      const user = getCurrentUser();
      if (user) {
        throw new Error('Authenticated user but Supabase connection failed. Cannot fall back to local mode.');
      }
      dbMode = 'local';
      console.log('[CleanBid DB] Falling back to local mode (no authenticated user)');
      return dbMode;
    }
  }

  dbMode = 'local';
  console.log('[CleanBid DB] Initialized in local mode');
  return dbMode;
}

function safeGetActivePref() {
  try { return localStorage.getItem('cleanbid_active_workspace') || null; } catch (_) { return null; }
}

/** Get current database mode. */
export function getDbMode() {
  return dbMode;
}

/** Get current workspace ID. */
export function getCurrentWorkspaceId() {
  return currentWorkspaceId;
}

/** Set current workspace ID (validated by the caller against memberships). */
export function setCurrentWorkspaceId(workspaceId) {
  currentWorkspaceId = workspaceId;
  try { localStorage.setItem('cleanbid_active_workspace', workspaceId); } catch (_) { /* ignore */ }
}

/** Load state from the appropriate backend. */
export async function loadState() {
  if (dbMode === 'supabase') return loadStateFromSupabase();
  return loadStateFromLocal();
}

/**
 * Fetch ALL activity rows for a workspace using range pagination.
 * Replaces the old .limit(50) cap which silently truncated history in
 * every cloud backup/export (audit finding P1-1).
 */
async function fetchAllActivity(workspaceId) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('activity_log')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
    if (from > 200000) throw new Error('Activity log exceeds sane size (200k rows); refusing to paginate further.');
  }
  return all.reverse(); // newest-first, matching previous UI ordering
}

/**
 * Save state to the appropriate backend. In Supabase mode, saves are debounced.
 */
export async function saveState(state) {
  window.__cleanbid_state = state;
  if (dbMode === 'supabase') {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveStateToSupabase(state);
      saveTimeout = null;
    }, 100);
  } else {
    saveStateToLocal(state);
  }
}

/** Immediately flush any pending saves. */
export async function flushSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    const state = window.__cleanbid_state;
    if (state && dbMode === 'supabase') {
      await saveStateToSupabase(state);
    }
  }
}

// ====================================================================
// LOCAL STORAGE
// ====================================================================

export function loadStateFromLocal() {
  try {
    const raw = localStorage.getItem(localStoreKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      console.log('[CleanBid DB] Loaded state from localStorage');
      return parsed;
    }
  } catch (e) {
    console.error('[CleanBid DB] Failed to load local state:', e);
  }
  console.log('[CleanBid DB] No local state found, using defaults');
  return null;
}

function saveStateToLocal(state) {
  try {
    localStorage.setItem(localStoreKey(), JSON.stringify(state));
  } catch (e) {
    console.error('[CleanBid DB] Failed to save local state:', e);
  }
}

/** Load demo state from separate storage. */
export function loadDemoState() {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('[CleanBid DB] Failed to load demo state:', e);
  }
  return null;
}

/** Save demo state to separate storage. */
export function saveDemoState(state) {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[CleanBid DB] Failed to save demo state:', e);
  }
}

/** Clear demo state. */
export function clearDemoState() {
  localStorage.removeItem(DEMO_STORAGE_KEY);
}

// ====================================================================
// SUPABASE
// ====================================================================

/**
 * Load the COMPLETE workspace state from Supabase.
 *
 * Fixes the prior cloud-read gap: previously only customers/properties/quotes/
 * profiles/activity were loaded. Workspace-scoped config (org, pricing,
 * addons, tasks, areaTypes) lives on the `workspaces` row as JSONB, and the
 * team (`users`) is derived from `workspace_members`. All entities are scoped
 * by the active workspace id.
 */
async function loadStateFromSupabase() {
  if (!currentWorkspaceId || !supabase) {
    console.log('[CleanBid DB] No workspace selected');
    return null;
  }

  try {
    const [
      wsRes,
      customersRes,
      propertiesRes,
      quotesRes,
      profilesRes,
      activityRows, // fully paginated by fetchAllActivity (P1-1)
      membersRes,
    ] = await Promise.all([
      supabase.from('workspaces')
        .select('branding, pricing_defaults, addons, tasks, area_types')
        .eq('id', currentWorkspaceId)
        .maybeSingle(),
      supabase.from('customers').select('*').eq('workspace_id', currentWorkspaceId),
      supabase.from('properties').select('*').eq('workspace_id', currentWorkspaceId),
      supabase.from('quotes').select('*').eq('workspace_id', currentWorkspaceId).order('created_at', { ascending: false }),
      supabase.from('pricing_profiles').select('*').eq('workspace_id', currentWorkspaceId),
      fetchAllActivity(currentWorkspaceId),
      supabase
        .from('workspace_members')
        .select('role, users(id, email, full_name)')
        .eq('workspace_id', currentWorkspaceId),
    ]);

    if (wsRes && wsRes.error) throw wsRes.error;
    if (customersRes.error) throw customersRes.error;
    if (propertiesRes.error) throw propertiesRes.error;
    if (quotesRes.error) throw quotesRes.error;
    if (profilesRes.error) throw profilesRes.error;
    if (membersRes.error) throw membersRes.error;

    const settings = mapWorkspaceSettingsFromDb(wsRes?.data || {});
    const customers = (customersRes.data || []).map(mapCustomerFromDb);
    const properties = (propertiesRes.data || []).map(mapPropertyFromDb);
    const quotes = (quotesRes.data || []).map(mapQuoteFromDb);
    const profiles = (profilesRes.data || []).map(mapProfileFromDb);
    const activity = (activityRows || []).map(mapActivityFromDb);
    const users = (membersRes.data || []).map(mapMemberToUser);

    // Derive customerId for quotes from their property's customer_id
    const propertyMap = new Map(properties.map((p) => [p.id, p.customerId]));
    quotes.forEach((q) => {
      if (!q.customerId && q.propertyId && propertyMap.has(q.propertyId)) {
        q.customerId = propertyMap.get(q.propertyId);
      }
    });

    const state = {
      ...settings,
      customers,
      properties,
      quotes,
      profiles,
      activity,
      users,
    };

    console.log(`[CleanBid DB] Loaded from Supabase: ${state.customers.length} customers, ${state.quotes.length} quotes`);
    return state;
  } catch (error) {
    console.error('[CleanBid DB] Failed to load state from Supabase:', error);
    throw error;
  }
}

/**
 * Save the COMPLETE workspace state to Supabase.
 * - Entities (customers/properties/quotes/profiles) are upserted per row.
 * - Workspace-scoped config (org/pricing/addons/tasks/areaTypes) is written
 *   to the `workspaces` row via UPDATE (members only, per RLS).
 * - `users` (team) is managed through workspace_members, not written here.
 */
export async function saveStateToSupabase(state) {
  if (!currentWorkspaceId || !supabase) {
    console.warn('[CleanBid DB] No workspace ID, skipping save');
    return;
  }

  try {
    const rows = [
      ...(state.customers || []).map((c) => mapCustomerToDb(c, currentWorkspaceId)),
      ...(state.properties || []).map((p) => mapPropertyToDb(p, currentWorkspaceId)),
      ...(state.quotes || []).map((q) => mapQuoteToDb(q, currentWorkspaceId)),
      ...(state.profiles || []).map((p) => mapProfileToDb(p, currentWorkspaceId)),
    ];

    // Upsert entities. We batch by table to keep round-trips low.
    if (state.customers?.length) {
      const { error } = await supabase.from('customers').upsert(rows.slice(0, state.customers.length));
      if (error) throw error;
    }
    if (state.properties?.length) {
      const offset = state.customers.length;
      const { error } = await supabase.from('properties').upsert(rows.slice(offset, offset + state.properties.length));
      if (error) throw error;
    }
    if (state.quotes?.length) {
      const offset = state.customers.length + state.properties.length;
      const { error } = await supabase.from('quotes').upsert(rows.slice(offset, offset + state.quotes.length));
      if (error) throw error;
    }
    if (state.profiles?.length) {
      const offset = state.customers.length + state.properties.length + state.quotes.length;
      const { error } = await supabase.from('pricing_profiles').upsert(rows.slice(offset, offset + state.profiles.length));
      if (error) throw error;
    }

    // Workspace-scoped config -> workspaces row.
    const settings = mapWorkspaceSettingsToDb(state);
    const { error: wsError } = await supabase
      .from('workspaces')
      .update(settings)
      .eq('id', currentWorkspaceId);
    if (wsError) throw wsError;

    console.log('[CleanBid DB] State saved to Supabase');
  } catch (error) {
    console.error('[CleanBid DB] Failed to save state to Supabase:', error);
    throw error;
  }
}

// ====================================================================
// WORKSPACE SETTINGS MAPPERS (org/pricing/addons/tasks/areaTypes <-> workspaces JSONB)
// ====================================================================

function mapWorkspaceSettingsFromDb(row) {
  const def = defaultWorkspaceData();
  const org = (row.branding && typeof row.branding === 'object') ? { ...def.org, ...row.branding } : { ...def.org };
  const pricing = (row.pricing_defaults && typeof row.pricing_defaults === 'object') ? { ...def.pricing, ...row.pricing_defaults } : { ...def.pricing };
  return {
    org,
    pricing,
    addons: Array.isArray(row.addons) ? row.addons : [],
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    areaTypes: Array.isArray(row.area_types) ? row.area_types : [],
  };
}

function mapWorkspaceSettingsToDb(state) {
  return {
    branding: state.org || {},
    pricing_defaults: state.pricing || {},
    addons: state.addons || [],
    tasks: state.tasks || [],
    area_types: state.areaTypes || [],
  };
}

function mapMemberToUser(m) {
  const u = m.users || {};
  return {
    id: u.id,
    name: u.full_name || u.email || 'Team member',
    email: u.email || '',
    role: m.role || 'member',
    lastActive: '—',
  };
}

// ====================================================================
// ENTITY MAPPERS (local format <-> database format)
// ====================================================================

function mapCustomerFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    company: row.company,
    contact: row.contact,
    email: row.email,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    lastActivity: row.last_activity,
  };
}

function mapCustomerToDb(customer, workspaceId) {
  return {
    id: customer.id,
    workspace_id: workspaceId || customer.workspaceId,
    company: customer.company,
    contact: customer.contact,
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
    notes: customer.notes,
    last_activity: customer.lastActivity,
    updated_at: new Date().toISOString(),
  };
}

function mapPropertyFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    name: row.name,
    address: row.address,
    type: row.type,
    sqft: row.sqft,
    floors: row.floors,
    quoteCount: row.quote_count,
    lastQuoted: row.last_quoted,
  };
}

function mapPropertyToDb(property, workspaceId) {
  return {
    id: property.id,
    workspace_id: workspaceId || property.workspaceId,
    customer_id: property.customerId,
    name: property.name,
    address: property.address,
    type: property.type,
    sqft: property.sqft,
    floors: property.floors,
    quote_count: property.quoteCount,
    last_quoted: property.lastQuoted,
    updated_at: new Date().toISOString(),
  };
}

function mapQuoteFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: null,
    propertyId: row.property_id,
    propertyName: row.property_name,
    companyName: row.company_name,
    contact: row.contact,
    email: row.email,
    phone: row.phone,
    propertyAddress: row.property_address,
    sqft: row.sqft,
    floors: row.floors,
    type: row.type,
    frequency: row.frequency,
    package: row.package,
    profileId: row.profile_id,
    profileName: row.profile_name,
    areas: row.areas || [],
    tasks: row.tasks || [],
    addons: row.addons || [],
    cleaners: row.cleaners,
    hoursPerVisit: row.hours_per_visit,
    visitsPerMonth: row.visits_per_month,
    monthly: row.monthly,
    annual: row.annual,
    margin: row.margin,
    costPerVisit: row.cost_per_visit,
    laborPerVisit: row.labor_per_visit,
    burdenPerVisit: row.burden_per_visit,
    suppliesPerVisit: row.supplies_per_visit,
    overheadPerVisit: row.overhead_per_visit,
    addonsPerVisit: row.addons_per_visit,
    status: row.status,
    version: row.version,
    versions: row.versions || [],
    followup: row.followup,
    lostReason: row.lost_reason,
    priceSnap: row.price_snap || {},
    productivitySnap: row.productivity_snap || {},
    calcMonthly: row.calc_monthly,
    override: row.override || {},
    date: row.date,
    modified: row.modified,
    createdIso: row.created_iso,
    modifiedIso: row.modified_iso,
  };
}

function mapQuoteToDb(quote, workspaceId) {
  return {
    id: quote.id,
    workspace_id: workspaceId || quote.workspaceId,
    property_id: quote.propertyId,
    property_name: quote.propertyName,
    company_name: quote.companyName,
    contact: quote.contact,
    email: quote.email,
    phone: quote.phone,
    property_address: quote.propertyAddress,
    sqft: quote.sqft,
    floors: quote.floors,
    type: quote.type,
    frequency: quote.frequency,
    package: quote.package,
    profile_id: quote.profileId,
    profile_name: quote.profileName,
    areas: quote.areas || [],
    tasks: quote.tasks || [],
    addons: quote.addons || [],
    cleaners: quote.cleaners,
    hours_per_visit: quote.hoursPerVisit,
    visits_per_month: quote.visitsPerMonth,
    monthly: quote.monthly,
    annual: quote.annual,
    margin: quote.margin,
    cost_per_visit: quote.costPerVisit,
    labor_per_visit: quote.laborPerVisit,
    burden_per_visit: quote.burdenPerVisit,
    supplies_per_visit: quote.suppliesPerVisit,
    overhead_per_visit: quote.overheadPerVisit,
    addons_per_visit: quote.addonsPerVisit,
    status: quote.status,
    version: quote.version,
    versions: quote.versions || [],
    followup: quote.followup,
    lost_reason: quote.lostReason,
    price_snap: quote.priceSnap || {},
    productivity_snap: quote.productivitySnap || {},
    calc_monthly: quote.calcMonthly,
    override: quote.override || {},
    date: quote.date,
    modified: quote.modified,
    created_iso: quote.createdIso,
    modified_iso: quote.modifiedIso,
    updated_at: new Date().toISOString(),
  };
}

function mapProfileFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    wage: parseFloat(row.wage),
    burden: parseFloat(row.burden),
    overhead: parseFloat(row.overhead),
    margin: parseFloat(row.margin),
    minPrice: row.min_price,
    supplies: parseFloat(row.supplies),
    productivity: row.productivity || {},
  };
}

function mapProfileToDb(profile, workspaceId) {
  return {
    id: profile.id,
    workspace_id: workspaceId || profile.workspaceId,
    name: profile.name,
    wage: profile.wage,
    burden: profile.burden,
    overhead: profile.overhead,
    margin: profile.margin,
    min_price: profile.minPrice,
    supplies: profile.supplies,
    productivity: profile.productivity,
    is_default: profile.is_default || false,
    updated_at: new Date().toISOString(),
  };
}

function mapActivityFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    avt: '',
    actor: '',
    what: row.action,
    object: '',
    time: formatTimeAgo(row.created_at),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    metadata: row.metadata || {},
  };
}

function formatTimeAgo(dateString) {
  if (!dateString) return 'Just now';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ====================================================================
// CLOUD RESTORE (P0-1) — atomic, server-authoritative workspace replace
// ====================================================================

/**
 * Restore a full workspace backup into the ACTIVE workspace via the
 * `restore_workspace_backup` Postgres RPC.
 *
 * Security model:
 *   - workspace identity is derived SERVER-SIDE from auth.uid() and the
 *     p_target_workspace argument is verified against workspace_members
 *     inside the SECURITY DEFINER function. Client-supplied workspace_id
 *     values inside record payloads are IGNORED by design (the RPC never
 *     reads them).
 *   - The whole replace runs inside a single transaction: any failure
 *     rolls back ALL deletes/inserts (no half-restored workspace, no
 *     window where another workspace's rows are exposed).
 *
 * @param {object} state - restored application state (workspace-owned keys)
 * @param {string|null} targetWorkspaceId - must equal the active workspace
 * @returns {Promise<{workspace_id:string, counts:object}>}
 */
export async function restoreStateToSupabase(state, targetWorkspaceId) {
  if (!supabase) throw new Error('Cloud restore requires a configured Supabase backend.');
  if (!targetWorkspaceId) {
    targetWorkspaceId = currentWorkspaceId;
  }
  if (!targetWorkspaceId || !dbMode) {
    throw new Error('Cloud restore refused: no active workspace context.');
  }
  if (targetWorkspaceId !== currentWorkspaceId) {
    throw new Error('Cloud restore refused: restore target does not match the ACTIVE workspace.');
  }

  // Client-supplied workspace_id fields are stripped here AND ignored by the
  // server function; the server stamps rows with its own derived workspace UUID.
  const strip = (arr) => (Array.isArray(arr) ? arr.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const { workspaceId, workspace_id, ...rest } = r;
    return rest;
  }) : []);

  const payload = {
    org: state.org || {},
    pricing: state.pricing || {},
    addons: strip(state.addons),
    tasks: strip(state.tasks),
    area_types: strip(state.areaTypes),
    customers: strip(state.customers),
    properties: strip(state.properties),
    quotes: strip(state.quotes),
    profiles: strip(state.profiles),
    activity: (Array.isArray(state.activity) ? state.activity : []).map((a) => ({
      action: a.what || a.action || 'restored activity entry',
      entity_type: a.entity_type || 'activity',
      entity_id: a.entity_id !== undefined ? a.entity_id : (a.object ?? null),
      metadata: a.metadata && typeof a.metadata === 'object' ? a.metadata : {},
      created_at: typeof a.createdIso === 'string' ? a.createdIso : new Date().toISOString(),
    })),
  };

  const { data, error } = await supabase.rpc('restore_workspace_backup', {
    p_target_workspace: targetWorkspaceId,
    p_payload: payload,
  });
  if (error) throw error;
  return data || { workspace_id: targetWorkspaceId };
}

/**
 * Test-only access to the persistence mappers (used by the round-trip
 * fidelity suite to prove local<->cloud logical equivalence).
 */
export const __mappers = {
  mapCustomerToDb, mapCustomerFromDb,
  mapPropertyToDb, mapPropertyFromDb,
  mapQuoteToDb, mapQuoteFromDb,
  mapProfileToDb, mapProfileFromDb,
  mapActivityToDbPayload: (a) => ({
    action: a.what || a.action || 'restored activity entry',
    entity_type: a.entity_type || 'activity',
    entity_id: a.entity_id !== undefined ? a.entity_id : (a.object ?? null),
    metadata: a.metadata && typeof a.metadata === 'object' ? a.metadata : {},
    created_at: typeof a.createdIso === 'string' ? a.createdIso : new Date().toISOString(),
  }),
};
