// Regression: CleanBid must not use native browser dialogs (alert/confirm/
// prompt). Malwarebytes flagged "Prompt Dialog Abuse" (Heuristics 10012) on
// the production site because of native confirm()/prompt() calls. All
// confirmation/input UX must go through the custom confirmAction()/promptAction()
// modals instead.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SHELL = resolve(process.cwd(), '03-app-shell.html');

describe('no native browser dialogs (Malwarebytes 10012)', () => {
  const html = existsSync(SHELL) ? readFileSync(SHELL, 'utf8') : '';

  it('source shell exists', () => {
    expect(html.length).toBeGreaterThan(1000);
  });

  // Strip comments (// line, /* */ block, <!-- -->) so doc prose like
  // "replaces native confirm()" doesn't false-positive. Then assert no real
  // native invocation remains.
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  it('has no native confirm( calls', () => {
    const code = strip(html);
    // confirmAction( is the custom helper (allowed); bare confirm( is native
    const natives = (code.match(/confirm\s*\(/g) || []).filter(s => !/confirmAction\s*\(/.test(s));
    expect(natives).toHaveLength(0);
  });

  it('has no native alert( calls', () => {
    const code = strip(html);
    expect((code.match(/alert\s*\(/g) || []).filter(s => !/alertAction\s*\(/.test(s))).toHaveLength(0);
  });

  it('has no native prompt( calls', () => {
    const code = strip(html);
    const natives = (code.match(/prompt\s*\(/g) || []).filter(s => !/promptAction\s*\(/.test(s));
    expect(natives).toHaveLength(0);
  });

  it('has no window.alert / window.confirm / window.prompt', () => {
    expect(html).not.toContain('window.alert');
    expect(html).not.toContain('window.confirm');
    expect(html).not.toContain('window.prompt');
  });

  it('provides the reusable custom modal helpers', () => {
    expect(html).toContain('function confirmAction(');
    expect(html).toContain('function promptAction(');
  });
});
