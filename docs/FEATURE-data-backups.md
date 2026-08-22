# Data & Backups — Workspace Export / Restore

**Branch:** `feature/data-export-restore`
**New files:** `src/backup.js` (canonical logic), `06-backup-restore.test.cjs` (63 checks)
**Modified:** `03-app-shell.html` (Data & backups card, restore modal, wiring)

## The problem

CleanBid kept 100% of customer, quote, and pricing data in browser
`localStorage`. Before this feature the app had **zero export capability**
(no `Blob` / `createObjectURL` anywhere in the shell). Clearing browser
data, a corrupt profile, or switching machines meant permanent,
silent loss of every customer and quote. For a product sold outright to
cleaning-company owners, that is the single fastest way to destroy trust.

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
