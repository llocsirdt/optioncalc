'use strict';
// A HELPER CALLED FROM TWO FUNCTIONS MUST LIVE AT MODULE SCOPE.
//
// 73454ff declared refreshUntouchedConfig and initRunSafe INSIDE processGroup. A `function` declaration
// hoists to its enclosing FUNCTION, not to the file, so the only caller that worked was the one that also
// lived in processGroup. The 30s sub-bar worker, session close and EOD settlement each threw
// `initRunSafe is not defined` on every invocation — three lost sessions of settlement (09-24, 09-25,
// 09-28: 560 eod_settlement_error events on the last of those) and a sub-bar worker dead since 09-23.
//
// Nothing caught it. `node --check` passes — the file is syntactically perfect. The unit suites passed —
// they exercise trader.js, not the scheduler in index.js. The per-variant try/catch from the same commit
// swallowed the ReferenceError and filed it as a settlement failure, and the boot backfill repaired the
// days behind it. So this checks the one property that was actually violated: a function declared inside
// another function is invisible to callers elsewhere in the file.
//
// Run: node server/tests/unit/candle-spread-module-scope.test.js
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const FILES = ['index.js', 'trader.js', 'order-manager.js', 'book-reconcile.js', 'store.js'];

// Brace depth per line, with strings and line comments neutralised. Crude, but it only has to agree with
// the real parser about DEPTH, and the files it reads are ordinary formatted JS.
function scopeMap(src) {
  const lines = src.split('\n');
  let depth = 0, topFn = null;
  const decls = [];     // { name, depth, topFn, line }
  const calls = [];     // { name, depth, topFn, line }
  const declRe = /^(\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (depth === 0) {
      const m = declRe.exec(raw);
      if (m && m[1] === '') topFn = m[2];
    }
    const d = declRe.exec(raw);
    if (d) decls.push({ name: d[2], depth, topFn, line: i + 1 });
    // Strip comments and string literals before reading braces or call sites.
    const code = raw.replace(/\/\/.*$/, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');
    for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      calls.push({ name: m[1], depth, topFn, line: i + 1 });
    }
    for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  }
  return { decls, calls, finalDepth: depth };
}

for (const f of FILES) {
  const p = path.join(__dirname, '..', '..', 'src', 'candle-spread', f);
  const src = fs.readFileSync(p, 'utf8');
  const { decls, calls, finalDepth } = scopeMap(src);
  // If this is off, the whole analysis below is meaningless — so it is an assertion, not an assumption.
  ok(finalDepth === 0, `${f}: brace depth balances to 0 (got ${finalDepth})`);

  const nested = decls.filter((d) => d.depth > 0 && d.topFn);
  for (const d of nested) {
    // Who calls it from somewhere this declaration cannot reach?
    const outside = calls.filter((c) => c.name === d.name && c.topFn !== d.topFn);
    if (outside.length) {
      const where = [...new Set(outside.map((c) => `${c.topFn || '(top level)'}:${c.line}`))].join(', ');
      ok(false, `${f}: function ${d.name} is declared inside ${d.topFn} (line ${d.line}) `
        + `but called from ${where} — a nested declaration is invisible there (ReferenceError at runtime)`);
    } else {
      pass++;   // nested but only used locally: fine
    }
  }
}

// ── A BUILT-IN USED WITHOUT BEING REQUIRED ──────────────────────────────────────────────────────────
// Same family as the nested-declaration bug and equally invisible to `node --check`: reach for `fs.` in a
// module that never required it and you get a ReferenceError. On 2026-09-30 a store-sweep block added to
// index.js used fs and path, neither of which that module imports at the top level — it would have thrown
// into its own catch and logged a sweep that silently never ran.
//
// MATCHED ON CALL PATTERNS, WITH NO COMMENT STRIPPING. The first version stripped comments by regex first and
// destroyed real code doing it (`fs.readdirSync` vanished from the stripped text, so the check passed on the
// very bug it was written for). Regex is a poor JavaScript parser; a short list of real call names is a
// reliable one, and it is verified to produce no false positives on the current tree.
{
  const CALLS = {
    fs: /\bfs\.(read|write|mkdir|exists|rm|stat|rename|open|close|createWrite|createRead|readdir)/,
    path: /\bpath\.(join|resolve|dirname|basename|extname|sep)/,
    os: /\bos\.(tmpdir|hostname|cpus|totalmem|freemem)/,
    crypto: /\bcrypto\.(createHash|randomUUID|randomBytes)/,
  };
  for (const f of FILES.concat(['seed-bundle.js', 'run-archive.js'])) {
    const p = path.join(__dirname, '..', '..', 'src', 'candle-spread', f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const [mod, re] of Object.entries(CALLS)) {
      if (!re.test(src)) { pass++; continue; }
      const required = new RegExp(`require\\(['"\`]${mod}['"\`]\\)`).test(src);
      ok(required, `${f}: calls \`${mod}.*\` and must require '${mod}' somewhere `
        + '(a module-level or in-block require both count; without one it is a runtime ReferenceError)');
    }
  }
}

// The four callers that actually broke, named explicitly. A generic rule can be weakened by accident; these
// are the sites that cost real sessions, so they are pinned by name.
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'candle-spread', 'index.js'), 'utf8');
  const { decls } = scopeMap(src);
  for (const name of ['initRunSafe', 'refreshUntouchedConfig']) {
    const d = decls.find((x) => x.name === name);
    ok(d && d.depth === 0,
      `index.js: ${name} is declared at MODULE scope (depth ${d ? d.depth : 'missing'}) — `
      + 'it is called from processGroup, runRestingWork and eodSettlementInner');
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
