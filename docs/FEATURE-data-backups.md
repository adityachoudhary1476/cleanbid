# Data & Backups — Workspace Export / Restore

> **v2 (audit-hardened).** See `supabase-restore-rpc.sql` header for the full P0-1 security model.
> Format version **2**: adds SHA-256 checksum, self-describing metadata (appVersion,
> full entity counts incl. activity), skip-and-report entity validation.
> Restore flow is now two-phase: *Prepare restore* (creates + auto-downloads a
> complete safety snapshot, keeps last 3) → explicit *Restore now* confirmation.
> Demo mode blocks real-data restores entirely. Cloud restores execute through
> the atomic server-side RPC `restore_workspace_backup` — never client upserts.

## Deployment requirement (cloud mode)

Run `supabase-restore-rpc.sql` once in Supabase SQL Editor before enabling
cloud users. It creates the atomic restore RPC, adds the `workspaces.addons /
tasks / area_types` columns the db layer always expected, adds WITH CHECK to
all UPDATE policies, and installs workspace_id-immutability triggers.
Until applied, cloud restore fails closed (RPC missing ⇒ error, no data change).

**Branch:** `feature/data-export-restore`
**New files:** `src/backup.js` (canonical logic), `06-backup-restore.test.cjs` (91 checks), `tests/restore-security.test.mjs` (8), `tests/fidelity.test.mjs` (13), `tests/backup-integrity.test.mjs` (16), `supabase-restore-rpc.sql`
**Modified:** `03-app-shell.html`, `src/db.js`

## Test coverage summary

```
02-pricing-tests.js            115 passed
04-activity-feed.test.cjs        8 passed
05-workspace-isolation.test     32 passed
06-backup-restore.test.cjs      91 passed   ← export/validate/apply/two-phase UX/demo gate/false-zero UI
tests/workspace-isolation.mjs   12 passed (vitest)
tests/restore-security.test      8 passed   ← cross-workspace isolation, atomic rollback, ID remap, hard fences
tests/fidelity.test             13 passed   ← mapper round-trips, nulls/zeros/hostile strings, declared normalizations
tests/backup-integrity.test     16 passed   ← checksum tamper rejection, hostile entities, snapshot ring, >1000-row pagination
npm run build                   ✓ clean
```


## What was built

### 1. One-click backup download

Branding page → **"Data & backups"** card → *Download backup*.

- Persists current edits first, then snapshots every workspace-owned key
  (org, pricing rules, profiles, areas/tasks vocabulary, customers,
  properties, quotes incl. version history + price snapshots, add-ons,
  users, activity).
- Downloads `cleanbid-backup-<workspace-slug>-<YYYY-MM-DD>.json`.
- Card shows live record counts plus "last export" timestamp per workspace.
- Global session state (`me`) is never exported; active-workspace context
  (`workspaceId`) is excluded from the payload — restoring changes content,
  never which namespace you are in.

### 2. Guided restore with preview and hard validation

*Restore from file…* opens a two-step modal:

1. Pick a `.json` file.
2. Review what was parsed: record counts, source workspace name, export
   date, warnings (e.g. "this backup contains no records — restoring will
   clear the workspace").

Only after explicit confirmation does anything touch state. Invalid or
foreign files show exact errors ("not valid JSON", "missing CleanBid
backup signature", corrupted sections) and **no changes are made**.

### 3. Canonical, tested core (`src/backup.js`)

Follows the repo's architecture rule: all semantics live DOM-free in
`src/`, the shell only renders. Three functions:

- `buildBackup(state)` — payload construction with deep clone + counts.
- `validateBackup(raw)` — parse/validate/warn BEFORE any state mutation.
- `applyBackup(state, data)` — REPLACE-everything restore built on
  `sanitizeWorkspaceState` from `src/state.js` (unknown keys dropped,
  missing keys defaulted). Object keys merge **over default shapes**, so a
  partial payload like `{pricing:{wage:21}}` still yields fully-formed
  state — downstream `Object.keys(state.pricing)` can never hit undefined.
  Verified against real render code during testing: naive wholesale
  replacement crashed `recalc()`; this design cannot.

## Test coverage — `node 06-backup-restore.test.cjs` (63 checks)

Loads the REAL app-shell inline script into a VM sandbox wired to the REAL
`src/state.js` + `src/backup.js` modules, exactly as production does:

| Section | Proves |
|---|---|
| buildBackup | signature/format, deep clone (mutating backup ≠ mutating state), no `me`, no `workspaceId` |
| validateBackup | rejects non-JSON, empty, foreign JSON, wrong format, missing payload, corrupted sections; warns on future dates and empty restores |
| applyBackup | replace-not-merge, rogue keys dropped, defaults filled, partial objects merged over defaults, global state untouched, reference isolation both ways |
| Round trip | export → wipe everything → restore → byte-for-byte recovery of customers/quotes/org/activity |
| Shell export | anchor click, filename pattern, JSON payload, blob URL lifecycle, per-workspace last-export stamp, success toast |
| Card | counters from live state, zero-state, last-export label |
| Restore preview | summary counts from file, confirm gating, hostile `<img onerror>` strings rendered inert |
| Restore commit | full replacement, context preserved, activity logged, modal closed, toast |
| Failure paths | invalid file ⇒ errors shown + confirm hidden + forced click is a no-op + state untouched; reopen resets previous attempt |

## Full suite status after this change

```
02-pricing-tests.js          115 passed · 0 failed
04-activity-feed.test.cjs      8 passed · 0 failed
05-workspace-isolation.test    32 passed · 0 failed
tests/workspace-isolation.mjs  12 passed (vitest)
06-backup-restore.test.cjs    63 passed · 0 failed   ← new
npm run build                  ✓ vite build clean
```

## Deliberate scope cuts (MVP boundary)

- No automatic scheduled backups — manual, user-triggered only for now.
- No multi-file backup history manager inside the app.
- No CSV/PDF export of individual lists (separate concern).
- Cloud-mode note: Supabase workspaces get the same file format; the file
  is produced from the same state layer regardless of backend mode.

## Next steps if continued

1. **Auto-backup reminder**: nudge when last export > 7 days and quotes exist.
2. **Backup history**: keep last N exports in IndexedDB, one-click re-restore.
3. **Per-list CSV export** (customers, quotes) for accountants.
4. Format v2: include schema checksum so partially-hand-edited files are caught earlier.
