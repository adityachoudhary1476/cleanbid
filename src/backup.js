/**
 * CleanBid — Workspace Backup, Restore & Safety Snapshots (canonical, DOM-free).
 *
 * Single source of truth for building, validating, and applying full
 * workspace backups plus pre-restore safety snapshots. Used by the app
 * shell (Data & Backups card) and by automated regression tests.
 *
 * Guarantees:
 *   - Backups contain ONLY workspace-owned keys (WORKSPACE_STATE_KEYS).
 *     Global session state (`me`) is never exported.
 *   - Restore REPLACES every workspace-owned key — never merges.
 *   - Object keys merge OVER default shapes so partial payloads can never
 *     produce half-formed state downstream.
 *   - Validation distinguishes: invalid backup (reject) / partially
 *     recoverable (skip bad records, report) / valid.
 *   - Tamper detection: SHA-256 checksum over the canonical payload core
 *     (verified when crypto.subtle is available).
 *   - Safety snapshots: complete-state ring buffer (latest 3) persisted
 *     BEFORE any destructive restore. Snapshot failure blocks restore.
 */

import {
  WORKSPACE_STATE_KEYS,
  sanitizeWorkspaceState,
  defaultWorkspaceData,
} from './state.js';

/** Bump when the backup payload shape changes in a breaking way. */
export const BACKUP_FORMAT_VERSION = 2;

/** Marker written into every export; required on import. */
export const BACKUP_MARKER = 'cleanbid_backup';

/** App version stamped into exports (keep in sync with package.json). */
export const BACKUP_APP_VERSION = '0.1.0';

/** Maximum safety snapshots retained per workspace. */
export const SAFETY_SNAPSHOT_LIMIT = 3;

const STORAGE_KEY_SNAPSHOTS = 'cleanbid_safety_snapshots_v1';

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function deepClone(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

/**
 * Stable JSON stringify (sorted object keys) — checksum-safe serialization.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * SHA-256 hex digest of a string via WebCrypto. Returns null when the
 * platform offers no crypto.subtle (tests may inject their own digester).
 */
export async function sha256Hex(text) {
  try {
    if (globalThis.crypto && globalThis.crypto.subtle && typeof TextEncoder !== 'undefined') {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------

/**
 * Build a portable backup payload from live application state.
 *
 * @param {object} state - live app state (workspace-owned keys are read)
 * @param {object} [opts]
 * @param {function} [opts.now] - ISO timestamp provider (injectable for tests)
 * @returns {{cleanbid_backup:boolean, format:number, exportedAt:string,
 *            appVersion:string, workspaceId:(string|null), workspaceName:string,
 *            orgName:string, counts:object, checksum:null, data:object}}
 *           `checksum` is filled by sealBackup().
 */
export function buildBackup(state, opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : (() => new Date().toISOString());
  const data = {};
  for (const key of WORKSPACE_STATE_KEYS) {
    if (key === 'workspaceId') continue; // context, not content
    data[key] = deepClone(state && state[key]);
  }
  const countOf = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
  const counts = {
    customers: countOf('customers'),
    properties: countOf('properties'),
    quotes: countOf('quotes'),
    profiles: countOf('profiles'),
    addons: countOf('addons'),
    tasks: countOf('tasks'),
    areaTypes: countOf('areaTypes'),
    users: countOf('users'),
    activity: countOf('activity'),
  };
  return {
    [BACKUP_MARKER]: true,
    format: BACKUP_FORMAT_VERSION,
    exportedAt: now(),
    appVersion: BACKUP_APP_VERSION,
    workspaceId: (state && state.workspaceId) || null,
    workspaceName: (state && state.org && state.org.name) || '',
    orgName: (state && state.org && state.org.name) || '',
    counts,
    checksum: null, // sealed by sealBackup()
    data,
  };
}

/**
 * Compute and attach the integrity checksum. Export flows MUST call this
 * before writing the file. Returns the same backup object (mutated).
 */
export function sealBackup(backup, digestFn) {
  const core = stableStringify({
    format: backup.format,
    exportedAt: backup.exportedAt,
    data: backup.data,
  });
  const d = digestFn || sha256Hex;
  return Promise.resolve(d(core)).then((hex) => {
    backup.checksum = hex || null;
    return backup;
  });
}

/**
 * Verify the checksum of a parsed backup. Backups exported without a
 * checksum (legacy v1) verify as `unverified`, not tampered.
 *
 * @returns {Promise<{status:'ok'|'tampered'|'unverified'|'unsupported',
 *                     expected?:string|null, actual?:string|null}>}
 */
export async function verifyChecksum(backup, digestFn) {
  if (!backup || typeof backup !== 'object') return { status: 'unverified' };
  if (typeof backup.checksum !== 'string' || !backup.checksum) return { status: 'unverified' };
  const core = stableStringify({
    format: backup.format,
    exportedAt: backup.exportedAt,
    data: backup.data,
  });
  const d = digestFn || sha256Hex;
  const actual = await Promise.resolve(d(core));
  if (!actual) return { status: 'unsupported' }; // platform cannot digest
  return {
    status: actual.toLowerCase() === backup.checksum.toLowerCase() ? 'ok' : 'tampered',
    expected: backup.checksum,
    actual,
  };
}

/**
 * Quick record counts from live state (for UI display).
 */
export function summarizeState(state) {
  const counts = {};
  for (const key of ['customers', 'properties', 'quotes']) {
    counts[key] = Array.isArray(state && state[key]) ? state[key].length : 0;
  }
  return counts;
}

// ---------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------

/** Required fields per entity kind. Records failing these are SKIPPED (reported),
 *  not silently coerced. Structural corruption (non-array sections) rejects. */
const ENTITY_REQUIREMENTS = {
  customers: (r) => r && r.id !== undefined && r.id !== null && typeof r.company === 'string' && r.company.length > 0,
  properties: (r) => r && r.id !== undefined && r.id !== null && typeof r.name === 'string' && r.name.length > 0,
  quotes: (r) => r && r.id !== undefined && r.id !== null &&
    (typeof r.propertyName === 'string' || typeof r.property_name === 'string') &&
    (typeof r.monthly === 'number' ? Number.isFinite(r.monthly)
      : r.monthly === undefined || r.monthly === null ? true
      : !Number.isNaN(Number(r.monthly)) && String(r.monthly).trim() !== ''),
  profiles: (r) => r && r.id !== undefined && r.id !== null && typeof r.name === 'string',
  addons: (r) => !!r && (r.id !== undefined ? true : true) && typeof r === 'object' && !Array.isArray(r),
  tasks: () => true,
  areaTypes: () => true,
  users: () => true,
  activity: (r) => !!r && typeof r === 'object' && !Array.isArray(r) &&
    (typeof r.what === 'string' || typeof r.action === 'string'),
};

/**
 * Sanitize one entity array: drops malformed records, reports them.
 *
 * @returns {{records:object[], skipped:{index:number, reason:string}[]}}
 */
function filterEntities(kind, arr) {
  const records = [];
  const skipped = [];
  const check = ENTITY_REQUIREMENTS[kind];
  arr.forEach((r, index) => {
    if (check(r)) {
      records.push(r);
    } else if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      skipped.push({ index, reason: `${kind}[${index}] is not an object` });
    } else {
      const label = r && (r.company || r.name || r.propertyName || r.property_name || r.what || r.action);
      skipped.push({ index, reason: `${kind}[${index}] missing required fields${label ? ` (${String(label).slice(0, 40)})` : ''}` });
    }
  });
  return { records, skipped };
}

/**
 * Validate an unparsed backup string/object BEFORE anything touches state.
 * Async because checksum verification is async.
 *
 * Classification:
 *   ok=false                      -> invalid backup; NEVER restore.
 *   ok=true, recoverable=false    -> clean valid backup.
 *   ok=true, recoverable=true     -> usable; some records were skipped
 *                                    (see result.skipped / result.summary).
 *
 * @param {string|object} raw - JSON text or parsed object
 * @param {object} [opts] { digestFn }
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], skipped:object[],
 *            parsed:object|null, summary:object|null, checksum:'ok'|'tampered'|'unverified'|'unsupported'|null}>}
 */
export async function validateBackup(raw, opts) {
  const errors = [];
  const warnings = [];
  let parsed = null;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: ['File is not valid JSON: ' + e.message], warnings, skipped: [], parsed: null, summary: null, checksum: null };
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  } else {
    return { ok: false, errors: ['Nothing to import — file was empty.'], warnings, skipped: [], parsed: null, summary: null, checksum: null };
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
    // Integrity: reject tampered payloads outright.
    let checksumStatus = null;
    if (parsed[BACKUP_MARKER]) {
      const verdict = await verifyChecksum(parsed, opts && opts.digestFn);
      checksumStatus = verdict.status;
      if (verdict.status === 'tampered') {
        errors.push('Integrity check FAILED — the file was modified or corrupted after export (checksum mismatch).');
      } else if (verdict.status === 'ok') {
        // silent success
      } else if (verdict.status === 'unverified') {
        warnings.push('This backup has no integrity checksum (older export). Contents were not tamper-checked.');
      } // 'unsupported': platform cannot digest -> do not punish the user
    }
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      errors.push('Backup payload has no readable workspace data.');
    } else {
      // Structural corruption rejects the whole restore…
      for (const key of ['customers', 'quotes', 'properties']) {
        if (parsed.data[key] !== undefined && !Array.isArray(parsed.data[key])) {
          errors.push(`"${key}" section is corrupted (expected a list).`);
        }
      }
      // …while record-level damage is skippable-and-reported.
      const skipped = [];
      if (errors.length === 0) {
        const cleanedData = {};
        for (const key of Object.keys(parsed.data)) {
          const val = parsed.data[key];
          if (Array.isArray(val)) {
            if (ENTITY_REQUIREMENTS[key]) {
              const res = filterEntities(key, val);
              cleanedData[key] = res.records;
              skipped.push(...res.skipped.map((s) => ({ ...s, kind: key })));
            } else {
              cleanedData[key] = val.filter((r) => r !== null && typeof r === 'object');
            }
          } else if (val !== null && typeof val === 'object') {
            cleanedData[key] = val;
          }
          // primitives other than the known object keys are dropped silently
        }
        parsed = { ...parsed, data: cleanedData };

        const total = ['customers', 'properties', 'quotes', 'addons', 'profiles']
          .reduce((n, k) => n + (Array.isArray(cleanedData[k]) ? cleanedData[k].length : 0), 0);
        if (total === 0) {
          warnings.push('This backup contains no records — restoring will clear the current workspace.');
        }
        if (skipped.length) {
          warnings.push(`${skipped.length} damaged record${skipped.length > 1 ? 's were' : ' was'} skipped during validation.`);
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
    }
  }

  const ok = errors.length === 0;
  const summary = ok && parsed ? {
    orgName: parsed.orgName || '',
    workspaceName: parsed.workspaceName || parsed.orgName || '',
    appVersion: parsed.appVersion || '',
    exportedAt: parsed.exportedAt || '',
    counts: parsed.counts || {},
    activityCount: Array.isArray(parsed.data.activity) ? parsed.data.activity.length : (parsed.counts && parsed.counts.activity) || 0,
  } : null;

  const skippedAll = ok && parsed ? collectSkipped(parsed) : [];

  return { ok, errors, warnings, skipped: skippedAll, parsed, summary, checksum: ok ? summaryChecksum(parsed) : null };
}

function collectSkipped(parsed) {
  // After filtering, skipped records are already removed from data; surface
  // the delta between declared counts and actual records for transparency.
  const out = [];
  if (!parsed.counts || !parsed.data) return out;
  for (const key of Object.keys(parsed.counts)) {
    const declared = parsed.counts[key];
    const actual = Array.isArray(parsed.data[key]) ? parsed.data[key].length : undefined;
    if (typeof declared === 'number' && typeof actual === 'number' && actual < declared) {
      out.push({ kind: key, index: -1, reason: `${declared - actual} record(s) listed in backup header missing/damaged in payload` });
    }
  }
  return out;
}

function summaryChecksum(parsed) {
  return parsed.checksum ? 'present' : null;
}

// ---------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------

/**
 * Apply validated backup data onto live state. REPLACES every
 * workspace-owned key (never merges). The active workspace context
 * (`state.workspaceId`) is preserved.
 *
 * ALSO resets derived in-memory sequences (e.g. `_quoteSeq`) so ID
 * generation reseeds from the RESTORED records, not from pre-restore ones.
 */
export function applyBackup(state, backupData) {
  if (!state || typeof state !== 'object') {
    throw new Error('applyBackup: state must be an object');
  }
  if (!backupData || typeof backupData !== 'object') {
    throw new Error('applyBackup: backupData must be an object');
  }
  const clean = sanitizeWorkspaceState(backupData);
  const defaults = defaultWorkspaceData();
  for (const key of WORKSPACE_STATE_KEYS) {
    if (key === 'workspaceId') continue;
    const val = clean[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      state[key] = JSON.parse(JSON.stringify(Object.assign({}, defaults[key] || {}, val)));
    } else {
      state[key] = JSON.parse(JSON.stringify(val));
    }
  }
  // Derived caches must never survive a replace-style restore.
  delete state._quoteSeq;
  return state;
}

// ---------------------------------------------------------------------
// Safety snapshots (pre-restore ring buffer)
// ---------------------------------------------------------------------

function snapshotStore(storage) {
  const s = storage || globalThis.localStorage;
  try {
    const raw = s.getItem(STORAGE_KEY_SNAPSHOTS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeSnapshotStore(storage, arr) {
  const s = storage || globalThis.localStorage;
  s.setItem(STORAGE_KEY_SNAPSHOTS, JSON.stringify(arr));
}

/**
 * Create a COMPLETE safety snapshot of current state, persisted locally.
 * Throws on failure (quota, serialization) — callers MUST treat any throw
 * as "do not restore".
 *
 * @param {object} state - live app state
 * @param {object} [opts] { now, storage, label }
 * @returns {{savedAt:string, orgName:string, workspaceId:(string|null),
 *            counts:object, bytes:number}}
 */
export function createSafetySnapshot(state, opts) {
  const now = (opts && opts.now) || (() => new Date().toISOString());
  const storage = (opts && opts.storage) || globalThis.localStorage;
  const backup = buildBackup(state, { now: () => now() });
  const json = JSON.stringify(backup); // may throw on pathological structures
  const entry = {
    savedAt: backup.exportedAt,
    orgName: backup.orgName,
    workspaceId: backup.workspaceId,
    counts: backup.counts,
    bytes: json.length,
    payload: backup,
  };
  const ring = snapshotStore(storage);
  ring.unshift(entry);
  while (ring.length > SAFETY_SNAPSHOT_LIMIT) ring.pop(); // oldest removed safely
  writeSnapshotStore(storage, ring); // may throw on quota -> caller aborts restore
  return { savedAt: entry.savedAt, orgName: entry.orgName, workspaceId: entry.workspaceId, counts: entry.counts, bytes: entry.bytes };
}

/** List snapshot metadata (payload included) newest-first. */
export function listSafetySnapshots(opts) {
  const storage = (opts && opts.storage) || globalThis.localStorage;
  return snapshotStore(storage);
}

/** Fetch one snapshot's full payload by index (0 = newest). */
export function getSafetySnapshot(index, opts) {
  const list = listSafetySnapshots(opts);
  return list[index] || null;
}
