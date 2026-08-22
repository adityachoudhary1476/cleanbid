/**
 * CleanBid — Workspace Backup & Restore (canonical, DOM-free).
 *
 * Single source of truth for building, validating, and applying full
 * workspace backups. Used by the app shell (Data & Backups card on the
 * Branding page) and by automated regression tests.
 *
 * Design rules (mirrors src/state.js):
 *   - A backup contains ONLY workspace-owned keys (WORKSPACE_STATE_KEYS).
 *     Global session state (`me`) is never exported.
 *   - Restore REPLACES every workspace-owned key — never merges — so stale
 *     records cannot survive alongside imported data.
 *   - Incoming data is sanitized through `sanitizeWorkspaceState` from
 *     src/state.js, so unknown keys are dropped and missing keys fall back
 *     to defaults. This keeps older/newer backups loadable.
 */

import {
  WORKSPACE_STATE_KEYS,
  sanitizeWorkspaceState,
  defaultWorkspaceData,
} from './state.js';

/** Bump when the backup payload shape changes in a breaking way. */
export const BACKUP_FORMAT_VERSION = 1;

/** Marker written into every export; required on import. */
export const BACKUP_MARKER = 'cleanbid_backup';

/**
 * Build a portable backup payload from live application state.
 *
 * @param {object} state - live app state (workspace-owned keys are read)
 * @param {object} [opts]
 * @param {function} [opts.now] - ISO timestamp provider (injectable for tests)
 * @returns {{cleanbid_backup:boolean, format:number, exportedAt:string,
 *            workspaceId:(string|null), orgName:string, counts:object, data:object}}
 */
export function buildBackup(state, opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : (() => new Date().toISOString());
  const data = {};
  for (const key of WORKSPACE_STATE_KEYS) {
    if (key === 'workspaceId') continue; // context, not content
    data[key] = Array.isArray(state && state[key])
      ? JSON.parse(JSON.stringify(state[key]))
      : JSON.parse(JSON.stringify((state && state[key]) !== undefined ? state[key] : null));
  }
  const counts = {};
  for (const key of ['customers', 'properties', 'quotes']) {
    counts[key] = Array.isArray(data[key]) ? data[key].length : 0;
  }
  return {
    [BACKUP_MARKER]: true,
    format: BACKUP_FORMAT_VERSION,
    exportedAt: now(),
    workspaceId: (state && state.workspaceId) || null,
    orgName: (state && state.org && state.org.name) || '',
    counts,
    data,
  };
}

/**
 * Validate an unparsed backup string/object BEFORE anything touches state.
 *
 * @param {string|object} raw - JSON text or parsed object
 * @returns {{ok:boolean, errors:string[], warnings:string[], parsed:object|null,
 *            summary:{orgName:string, exportedAt:string, counts:object}|null}}
 */
export function validateBackup(raw) {
  const errors = [];
  const warnings = [];
  let parsed = null;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: ['File is not valid JSON: ' + e.message], warnings, parsed: null, summary: null };
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  } else {
    return { ok: false, errors: ['Nothing to import — file was empty.'], warnings, parsed: null, summary: null };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('Not a CleanBid backup file.');
  } else {
    if (!parsed[BACKUP_MARKER]) {
      errors.push('Missing CleanBid backup signature — this is not an export from this app.');
    }
    if (parsed.format !== undefined && parsed.format !== BACKUP_FORMAT_VERSION) {
      errors.push(`Unsupported backup format ${parsed.format} (this app reads format ${BACKUP_FORMAT_VERSION}).`);
    }
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      errors.push('Backup payload has no readable workspace data.');
    } else {
      for (const key of ['customers', 'quotes', 'properties']) {
        if (parsed.data[key] !== undefined && !Array.isArray(parsed.data[key])) {
          errors.push(`"${key}" section is corrupted (expected a list).`);
        }
      }
      const total = ['customers', 'properties', 'quotes', 'addons', 'profiles']
        .reduce((n, k) => n + (Array.isArray(parsed.data[k]) ? parsed.data[k].length : 0), 0);
      if (total === 0) {
        warnings.push('This backup contains no records — restoring will clear the current workspace.');
      }
    }
    if (parsed.exportedAt) {
      const t = Date.parse(parsed.exportedAt);
      if (Number.isNaN(t)) {
        warnings.push('Backup timestamp is unreadable.');
      } else if (t - Date.now() > 5 * 60 * 1000) {
        warnings.push('Backup timestamp is in the future.');
      }
    }
  }

  const ok = errors.length === 0;
  const summary = ok && parsed ? {
    orgName: parsed.orgName || '',
    exportedAt: parsed.exportedAt || '',
    counts: parsed.counts || {
      customers: Array.isArray(parsed.data.customers) ? parsed.data.customers.length : 0,
      properties: Array.isArray(parsed.data.properties) ? parsed.data.properties.length : 0,
      quotes: Array.isArray(parsed.data.quotes) ? parsed.data.quotes.length : 0,
    },
  } : null;

  return { ok, errors, warnings, parsed, summary };
}

/**
 * Quick record counts from live state (for UI display).
 *
 * @param {object} state - live app state
 * @returns {{customers:number, properties:number, quotes:number}}
 */
export function summarizeState(state) {
  const counts = {};
  for (const key of ['customers', 'properties', 'quotes']) {
    counts[key] = Array.isArray(state && state[key]) ? state[key].length : 0;
  }
  return counts;
}

/**
 * Apply validated backup data onto live state. REPLACES every
 * workspace-owned key (never merges). The active workspace context
 * (`state.workspaceId`) is preserved — restoring changes CONTENT, not
 * which storage namespace is active.
 *
 * @param {object} state - live app state (mutated in place)
 * @param {object} backupData - the `data` object from a VALIDATED backup
 * @returns {object} state
 */
export function applyBackup(state, backupData) {
  if (!state || typeof state !== 'object') {
    throw new Error('applyBackup: state must be an object');
  }
  if (!backupData || typeof backupData !== 'object') {
    throw new Error('applyBackup: backupData must be an object');
  }
  // Sanitize drops unknown keys and coerces shapes; missing keys become defaults.
  // Object keys merge over the default shape so partial payloads (e.g. pricing
  // without a `productivity` sub-object) still yield fully-formed state —
  // downstream code does Object.keys(state.pricing) and must never see undefined.
  const clean = sanitizeWorkspaceState(backupData);
  const defaults = defaultWorkspaceData();
  for (const key of WORKSPACE_STATE_KEYS) {
    if (key === 'workspaceId') continue; // preserve active namespace context
    const val = clean[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      state[key] = JSON.parse(JSON.stringify(Object.assign({}, defaults[key] || {}, val)));
    } else {
      state[key] = JSON.parse(JSON.stringify(val));
    }
  }
  return state;
}
