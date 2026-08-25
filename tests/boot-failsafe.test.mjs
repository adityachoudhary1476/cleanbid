// Regression: the public homepage must NEVER be gated behind auth, and the
// boot must include fail-safes so the user can never be stranded on a cream
// / blank screen. This guards the source that builds into the deployed shell.
//
// Repro context: users reported a persistent cream/white screen on fresh
// visits and after login across desktop + mobile + localhost. Root cause was
// the full-screen #authLoading cream overlay being shown at the very start
// of initAuthFlow, gating the public homepage behind auth bootstrap. The fix
// renders the landing immediately and only shows authLoading for the
// authenticated workspace-load step, with a finally{} fail-safe.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SHELL = resolve(process.cwd(), '03-app-shell.html');

describe('boot fail-safe (cream-screen regression)', () => {
  const html = existsSync(SHELL) ? readFileSync(SHELL, 'utf8') : '';

  it('source shell exists', () => {
    expect(html.length).toBeGreaterThan(1000);
  });

  it('renders the public landing immediately (not gated behind authLoading)', () => {
    // initAuthFlow must reveal #view-login BEFORE/independent of bootstrap,
    // and must NOT call authLoading.remove('hidden') at the top.
    expect(html).toContain("[CleanBid Boot] 02_landing_rendered");
    // The old "show loading first" line must be gone.
    expect(html).not.toContain("// Show loading");
  });

  it('has a single view-state controller and a no-blank fail-safe', () => {
    expect(html).toContain('window.setView = function');
    expect(html).toContain('ensureVisibleFallback');
    // Fallback forces the public homepage visible if nothing else is.
    expect(html).toContain('falling back to public homepage');
  });

  it('only shows authLoading AFTER deciding the user is authenticated', () => {
    // The old code revealed the cream overlay at function entry with a
    // literal "// Show loading" + classList.remove('hidden'). That must be gone.
    expect(html).not.toContain('// Show loading');
    // Instead, a dedicated helper reveals it only on the authenticated path.
    expect(html).toContain('const showAuthLoading = () =>');
    expect(html).toContain('showAuthLoading();');
  });

  it('surfaces a real error screen (not silent cream) on bootstrap failure', () => {
    expect(html).toContain('[CleanBid Boot ERROR]');
    expect(html).toContain('couldn’t finish loading'); // curly apostrophe as in source
  });
});
