/**
 * splice-landing-v2.cjs
 * Replaces the old landing markup in 03-app-shell.html with the v2 landing:
 *   - injects scripts/landing-v2.css before the closing </style> of the head
 *   - replaces the block from `<div class="hero">` up to (not incl.)
 *     `<!-- ============================================================
          APP SHELL` with scripts/landing-v2.html
 * The shell uses CRLF line endings; inserted files are normalized to CRLF.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const shellPath = path.join(root, '03-app-shell.html');

let html = fs.readFileSync(shellPath, 'utf8');
if (html.includes('LANDING v2 — public marketing homepage')) {
  console.log('landing-v2 already spliced — nothing to do');
  process.exit(0);
}

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const css = crlf(fs.readFileSync(path.join(root, 'scripts', 'landing-v2.css'), 'utf8'));
const landing = crlf(fs.readFileSync(path.join(root, 'scripts', 'landing-v2.html'), 'utf8'));

// --- 1. CSS injection -------------------------------------------------
const styleClose = '</style>\r\n</head>';
if (!html.includes(styleClose)) {
  console.error('FATAL: `</style>\\r\\n</head>` marker not found'); process.exit(1);
}
html = html.replace(styleClose, css + '\r\n' + styleClose);

// --- 2. Landing markup replacement ------------------------------------
const startMarker = '<div class="hero">';
const endMarker = '<!-- ============================================================\r\n     APP SHELL';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);
if (startIdx === -1) { console.error('FATAL: hero start marker not found'); process.exit(1); }
if (endIdx === -1) { console.error('FATAL: APP SHELL end marker not found'); process.exit(1); }
if (endIdx < startIdx) { console.error('FATAL: marker order unexpected'); process.exit(1); }

// The replaced region must contain the pieces we intend to retire.
const region = html.slice(startIdx, endIdx);
for (const mustContain of ['roi-sec', 'benefits-sec', 'Get started.', 'class="foot"', 'v1.0']) {
  if (!region.includes(mustContain)) {
    console.error(`FATAL: expected \`${mustContain}\` inside replaced region — aborting`);
    process.exit(1);
  }
}

html = html.slice(0, startIdx) + landing + '\r\n\r\n' + html.slice(endIdx);

fs.writeFileSync(shellPath, html);
console.log('OK: landing v2 spliced. Removed', region.length, 'chars, inserted', landing.length, 'chars.');
