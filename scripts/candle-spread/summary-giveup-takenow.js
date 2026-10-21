'use strict';
// Builds summary.md for the give-up take-now sweep from sweep.json.
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const { meta, rows } = JSON.parse(fs.readFileSync(path.join(dir, 'sweep.json'), 'utf8'));
const f = (n) => (n == null ? '' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const pad = (s, n) => String(s).padStart(n);
const variants = [...new Set(rows.map((r) => r.variant))];
const arms = [...new Set(rows.map((r) => r.arm))];
const get = (v, a) => rows.find((r) => r.variant === v && r.arm === a);
const out = [];
out.push(`# Give-up TAKE-NOW (runDay5m opts.giveUpTakeNowFrac) — ${meta.days} days ${meta.from}..${meta.to}, ${meta.n2026} NDX-priced 2026\n`);
out.push('Rule: when a give-up fires and the cover mark is within X x W past break-even, pay the mark (+tick) now; else the usual');
out.push('give-up price (break-even + allowance 5/7.5/10% by width). Risk cap active (roster path, optsFor, ladder opens, 1m sub-bars).\n');
const hdr = 'variant   arm    worst  maxDD30  IF>=0%  endFl locked  uncov/d  tn/d       total';
const line = (v, a, x) => `${v.padEnd(9)} ${a.padEnd(5)} ${pad(f(x.worst), 7)} ${pad(f(x.maxDD30), 8)} ${pad(x.ifNonNegPct, 6)} ${pad(f(x.avgEndFloor), 6)} ${pad(x.lockedPct, 6)} ${pad(x.uncoveredEodPerDay, 8)} ${pad(x.takeNowPerDay, 5)} ${pad(f(x.total), 11)}`;
for (const [era, key] of [['All days', 'all'], ['2026 only', 'y2026']]) {
  out.push(`## ${era}\n\n\`\`\`\n${hdr}`);
  for (const v of variants) for (const a of arms) { const r = get(v, a); if (r && r[key]) out.push(line(v, a, r[key])); }
  out.push('```\n');
}
// improved-vs-off counts: worst | maxDD30 | IF>=0% | endFloor | locked | uncovered (lower better) | total
const mets = [['worst', 1], ['maxDD30', 1], ['ifNonNegPct', 1], ['avgEndFloor', 1], ['lockedPct', 1], ['uncoveredEodPerDay', -1], ['total', 1]];
for (const [era, key] of [['all', 'all'], ['2026', 'y2026']]) {
  out.push(`## Improved vs off (${era}) — worst | maxDD30 | IF>=0% | endFloor | locked% | uncovered/day | total  (of ${variants.length})\n\n\`\`\``);
  for (const a of arms.filter((x) => x !== 'off')) {
    const c = mets.map(([m, s]) => variants.filter((v) => { const o = get(v, 'off'), r = get(v, a); return o && r && r[key] && o[key] && s * (r[key][m] - o[key][m]) > 0; }).length);
    out.push(`${a.padEnd(5)} ${c.map((x) => pad(x, 3)).join(' ')}`);
  }
  out.push('```\n');
}
fs.writeFileSync(path.join(dir, 'summary.md'), out.join('\n'));
console.log(out.join('\n'));
