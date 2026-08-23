/**
 * Verify every onclick handler referenced in 03-app-shell.html has a definition.
 */
const fs = require('fs');
const html = fs.readFileSync('03-app-shell.html', 'utf8');

const used = [...new Set(
  [...html.matchAll(/onclick="([a-zA-Z_$][a-zA-Z0-9_$]*)\(/g)].map(m => m[1])
)];

const missing = used.filter(fn =>
  !new RegExp(`function\\s+${fn}\\b`).test(html) &&
  !new RegExp(`window\\.${fn}\\s*=`).test(html) &&
  !new RegExp(`\\b${fn}\\s*=\\s*(function|async)`).test(html)
);

if (missing.length) {
  console.log('MISSING DEFS:', missing.join(', '));
  process.exit(1);
}
console.log(`OK: all ${used.length} onclick handlers have definitions`);
