/**
 * CleanBid — Workspace State Boundary (canonical, DOM-free).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the distinction between:
 *   - GLOBAL application state (auth session metadata, transient UI, config)
 *   - WORKSPACE state (customers, properties, quotes, pricing, profiles, etc.)
 *
 * It is imported by the app shell (via the module bootstrap) and by the
 * automated workspace-isolation tests. It intentionally contains NO DOM or
 * `window` references so it can run in Node/vitest as well as the browser.
 *
 * IMPORTANT: loading a workspace MUST NOT merge into the previously active
 * workspace's data. `replaceWorkspaceState` builds a FRESH workspace state
 * from the persisted blob (or from defaults) for every workspace-owned key,
 * preserving only explicitly-global keys (e.g. `me`).
 */

// Keys that belong to a single workspace and are fully replaced on switch.
export const WORKSPACE_STATE_KEYS = [
  'workspaceId',
  'org',
  'pricing',
  'profiles',
  'areaTypes',
  'tasks',
  'customers',
  'properties',
  'quotes',
  'addons',
  'users',
  'activity',
  'editQuota',
];

// Keys that are GLOBAL (current auth user / session metadata, transient UI)
// and must SURVIVE a workspace switch. They are never part of the persisted
// workspace blob and are never overwritten by `replaceWorkspaceState`.
export const GLOBAL_STATE_KEYS = [
  'me',
];

// Per-key expected shape, used to reject malformed persisted data.
const KEY_KIND = {
  workspaceId: 'primitive',
  org: 'object',
  pricing: 'object',
  profiles: 'array',
  areaTypes: 'array',
  tasks: 'array',
  'customers': 'array',
  'properties': 'array',
  'quotes': 'array',
  'addons': 'array',
  'users': 'array',
  'activity': 'array',
  'editQuota': 'object',
};

function clone(value) {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Default values for every workspace-owned key. The app shell passes its own
 * richer `defaultState()` as `getDefault` so defaults stay defined in one
 * place; this exists as a safe fallback / for isolated unit tests.
 */
export function defaultWorkspaceData() {
  return {
    workspaceId: null,
    org: {
      name: '', initial: '', phone: '', email: '', web: '', address: '',
      tagline: '', footer: '', color: '#3b82f6', license: '', trust: '', workspaceId: null,
    },
    pricing: {
      wage: 18, burden: 15, overhead: 12, margin: 25, minPrice: 800, supplies: 8,
      contract: '12 months', payment: 'Net 30', currency: 'USD', units: 'imperial',
      terms: '', productivity: {},
    },
    profiles: [],
    areaTypes: [],
    tasks: [],
    customers: [],
    properties: [],
    quotes: [],
    addons: [],
    users: [],
    activity: [],
    editQuota: null,
  };
}

/**
 * Return only the workspace-owned portion of a state object.
 */
export function extractWorkspaceState(state) {
  const out = {};
  for (const key of WORKSPACE_STATE_KEYS) {
    if (state && state[key] !== undefined) out[key] = state[key];
  }
  return out;
}

function defaultValueFor(key, getDefault) {
  if (typeof getDefault === 'function') {
    const def = getDefault();
    if (def && def[key] !== undefined) return clone(def[key]);
  }
  const fb = defaultWorkspaceData();
  return clone(fb[key]);
}

/**
 * Replace every workspace-owned key in `state` with either the persisted
 * value from `saved` (when present and well-typed) or a fresh default.
 *
 * Global keys (e.g. `me`) are never touched. Incoming workspace data is
 * deep-cloned so the active state never shares object references / arrays
 * with a cached or previously-loaded workspace blob.
 *
 * @param {object} state      the live application state (mutated in place)
 * @param {object|null} saved persisted workspace blob (may be partial/null)
 * @param {function} [getDefault] returns a full default-state object
 * @returns {object} state
 */
export function replaceWorkspaceState(state, saved, getDefault) {
  if (!state || typeof state !== 'object') {
    throw new Error('replaceWorkspaceState: state must be an object');
  }
  for (const key of WORKSPACE_STATE_KEYS) {
    // `workspaceId` is CONTEXT (the active workspace), set by the switch
    // handler — never overwritten by the persisted blob, or we would lose
    // the active storage namespace.
    if (key === 'workspaceId') continue;
    const incoming = saved ? saved[key] : undefined;
    const kind = KEY_KIND[key];

    if (incoming === undefined || incoming === null) {
      state[key] = defaultValueFor(key, getDefault);
      continue;
    }

    if (kind === 'array') {
      state[key] = Array.isArray(incoming) ? clone(incoming) : defaultValueFor(key, getDefault);
    } else if (kind === 'object') {
      const ok = incoming && typeof incoming === 'object' && !Array.isArray(incoming);
      state[key] = ok ? clone(incoming) : defaultValueFor(key, getDefault);
    } else {
      // primitive (workspaceId) — accept as-is
      state[key] = incoming;
    }
  }
  return state;
}

/**
 * Sanitize an untrusted persisted blob: keep only workspace-owned keys and
 * coerce them to valid shapes. Used before persistence to guarantee a clean
 * blob is written per workspace.
 */
export function sanitizeWorkspaceState(saved) {
  const out = {};
  for (const key of WORKSPACE_STATE_KEYS) {
    const incoming = saved ? saved[key] : undefined;
    const kind = KEY_KIND[key];
    if (incoming === undefined || incoming === null) {
      out[key] = defaultWorkspaceData()[key];
      continue;
    }
    if (kind === 'array') {
      out[key] = Array.isArray(incoming) ? incoming : [];
    } else if (kind === 'object') {
      out[key] = (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) ? incoming : defaultWorkspaceData()[key];
    } else {
      out[key] = incoming;
    }
  }
  return out;
}

/**
 * Build the localStorage key for a workspace. A null/empty workspaceId maps
 * to the legacy shared key so single-workspace local mode keeps working.
 */
export function workspaceStorageKey(base, workspaceId) {
  if (!workspaceId) return base;
  return `${base}_${workspaceId}`;
}

/**
 * Load a persisted workspace blob from an injected storage object.
 * Returns null when nothing is stored (caller should initialize clean).
 */
export function loadWorkspaceBlob(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Persist a workspace blob to an injected storage object.
 */
export function saveWorkspaceBlob(storage, key, blob) {
  storage.setItem(key, JSON.stringify(blob));
}
