/**
 * CleanBid Data Access Layer
 * 
 * Dual-mode: local (localStorage) or Supabase (cloud).
 * 
 * IMPORTANT RULES:
 * 1. Never silently fall back from authenticated cloud mode to localStorage.
 * 2. In local mode, workspace_id is a single fixed workspace.
 * 3. In cloud mode, workspace_id comes from the authenticated session.
 * 4. All write operations are debounced in cloud mode to avoid excessive API calls.
 */

import { isCloud, getCurrentUser, getUserWorkspaces } from './auth.js';

const LOCAL_STORAGE_KEY = 'cleanbid_v3';
const DEMO_STORAGE_KEY = 'cleanbid_demo_v3';

let dbMode = null; // 'local' | 'supabase' | null (uninitialized)
let supabase = null;
let currentWorkspaceId = null;
let saveTimeout = null;

/**
 * Initialize the database layer.
 */
export async function initDb() {
  if (dbMode !== null) return dbMode;

  if (isCloud()) {
    try {
      // Dynamic import to avoid requiring Supabase in local mode
      const { createClient } = await import('@supabase/supabase-js');
      supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY
      );

      // Get user's workspaces
      const workspaces = await getUserWorkspaces();
      if (workspaces.length > 0) {
        currentWorkspaceId = workspaces[0].id;
      }

      dbMode = 'supabase';
      console.log('[CleanBid DB] Initialized in Supabase mode');
      return dbMode;
    } catch (error) {
      console.error('[CleanBid DB] Failed to initialize Supabase:', error);
      // If we were explicitly authenticated but Supabase failed, DO NOT fall back
      const user = getCurrentUser();
      if (user) {
        throw new Error('Authenticated user but Supabase connection failed. Cannot fall back to local mode.');
      }
      // Only fall back to local if there's no authenticated user
      dbMode = 'local';
      console.log('[CleanBid DB] Falling back to local mode (no authenticated user)');
      return dbMode;
    }
  }

  dbMode = 'local';
  console.log('[CleanBid DB] Initialized in local mode');
  return dbMode;
}

/**
 * Get current database mode.
 */
export function getDbMode() {
  return dbMode;
}

/**
 * Get current workspace ID.
 */
export function getCurrentWorkspaceId() {
  return currentWorkspaceId;
}

/**
 * Set current workspace ID (for multi-workspace support).
 */
export function setCurrentWorkspaceId(workspaceId) {
  currentWorkspaceId = workspaceId;
}

/**
 * Load state from the appropriate backend.
 */
export async function loadState() {
  if (dbMode === 'supabase') {
    return loadStateFromSupabase();
  }
  return loadStateFromLocal();
}

/**
 * Save state to the appropriate backend.
 * In Supabase mode, saves are debounced.
 */
export async function saveState(state) {
  window.__cleanbid_state = state;
  if (dbMode === 'supabase') {
    // Debounce saves in cloud mode
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveStateToSupabase(state);
      saveTimeout = null;
    }, 100);
  } else {
    saveStateToLocal(state);
  }
}

/**
 * Immediately flush any pending saves.
 */
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

function loadStateFromLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
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
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[CleanBid DB] Failed to save local state:', e);
  }
}

/**
 * Load demo state from separate storage.
 */
export function loadDemoState() {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[CleanBid DB] Failed to load demo state:', e);
  }
  return null;
}

/**
 * Save demo state to separate storage.
 */
export function saveDemoState(state) {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[CleanBid DB] Failed to save demo state:', e);
  }
}

/**
 * Clear demo state.
 */
export function clearDemoState() {
  localStorage.removeItem(DEMO_STORAGE_KEY);
}

// ====================================================================
// SUPABASE
// ====================================================================

async function loadStateFromSupabase() {
  if (!currentWorkspaceId) {
    console.log('[CleanBid DB] No workspace selected');
    return null;
  }

  try {
    const [
      customersRes,
      propertiesRes,
      quotesRes,
      profilesRes,
      activityRes,
    ] = await Promise.all([
      supabase.from('customers').select('*').eq('workspace_id', currentWorkspaceId),
      supabase.from('properties').select('*').eq('workspace_id', currentWorkspaceId),
      supabase.from('quotes').select('*').eq('workspace_id', currentWorkspaceId).order('created_at', { ascending: false }),
      supabase.from('pricing_profiles').select('*').eq('workspace_id', currentWorkspaceId),
      supabase.from('activity_log').select('*').eq('workspace_id', currentWorkspaceId).order('created_at', { ascending: false }).limit(50),
    ]);

    if (customersRes.error) throw customersRes.error;
    if (propertiesRes.error) throw propertiesRes.error;
    if (quotesRes.error) throw quotesRes.error;
    if (profilesRes.error) throw profilesRes.error;
    if (activityRes.error) throw activityRes.error;

    // Transform database rows to app state format
    const customers = (customersRes.data || []).map(mapCustomerFromDb);
    const properties = (propertiesRes.data || []).map(mapPropertyFromDb);
    const quotes = (quotesRes.data || []).map(mapQuoteFromDb);
    const profiles = (profilesRes.data || []).map(mapProfileFromDb);
    const activity = (activityRes.data || []).map(mapActivityFromDb);

    // Derive customerId for quotes from their property's customer_id
    const propertyMap = new Map(properties.map(p => [p.id, p.customerId]));
    quotes.forEach(q => {
      if (!q.customerId && q.propertyId && propertyMap.has(q.propertyId)) {
        q.customerId = propertyMap.get(q.propertyId);
      }
    });

    const state = {
      customers,
      properties,
      quotes,
      profiles,
      activity,
    };

    console.log(`[CleanBid DB] Loaded from Supabase: ${state.customers.length} customers, ${state.quotes.length} quotes`);
    return state;
  } catch (error) {
    console.error('[CleanBid DB] Failed to load state from Supabase:', error);
    throw error;
  }
}

/**
 * Save state to Supabase directly.
 */
export async function saveStateToSupabase(state) {
  if (!currentWorkspaceId) {
    console.warn('[CleanBid DB] No workspace ID, skipping save');
    return;
  }

  try {
    // Save customers
    for (const customer of state.customers || []) {
      const dbCustomer = mapCustomerToDb(customer, currentWorkspaceId);
      const { error } = await supabase.from('customers').upsert(dbCustomer);
      if (error) throw error;
    }

    // Save properties
    for (const property of state.properties || []) {
      const dbProperty = mapPropertyToDb(property, currentWorkspaceId);
      const { error } = await supabase.from('properties').upsert(dbProperty);
      if (error) throw error;
    }

    // Save quotes
    for (const quote of state.quotes || []) {
      const dbQuote = mapQuoteToDb(quote, currentWorkspaceId);
      const { error } = await supabase.from('quotes').upsert(dbQuote);
      if (error) throw error;
    }

    // Save pricing profiles
    for (const profile of state.profiles || []) {
      const dbProfile = mapProfileToDb(profile, currentWorkspaceId);
      const { error } = await supabase.from('pricing_profiles').upsert(dbProfile);
      if (error) throw error;
    }

    console.log('[CleanBid DB] State saved to Supabase');
  } catch (error) {
    console.error('[CleanBid DB] Failed to save state to Supabase:', error);
    throw error;
  }
}

// ====================================================================
// MAPPERS (local format <-> database format)
// ====================================================================

function mapCustomerFromDb(row) {
  return {
    id: row.id,
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
    workspace_id: workspaceId,
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
    workspace_id: workspaceId,
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
    workspace_id: workspaceId,
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
    workspace_id: workspaceId,
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
