#!/usr/bin/env node
'use strict';
/**
 * report-baselines.js — THE TABLE VIEW for any baseline build.
 *
 * Standing preference: whenever we review a backtest summary or compare strategies, it is this table, not
 * prose. Five sections, in the order the questions actually get asked:
 *
 *   BOUND CHECK       Did the day-loss governor hold on EVERY governed variant x every day? This is a
 *                     safety property, so it leads — a headline P&L number is meaningless if the ceiling
 *                     leaked. Also shows which variants ran closest to the ceiling (least spare room).
 *   CAPPED vs UNCAPPED  What the $5k governor COSTS each family. Every governed variant has a `-unc` twin
 *                     run with identical signals and geometry and no cap, so the difference is the
 *                     governor and nothing else. `keep%` = capped total / uncapped total.
 *   BEST BY RET/DD    Ranked by return per unit of drawdown rather than by total, because the cap changes
 *                     the risk each variant takes and totals alone are not comparable across it.
 *   BEST BY TOTAL     The raw leaderboard, for when the question really is "which made the most".
 *   GOVERNOR ACTIVITY How the ceiling was actually held: the worst floor it allowed vs what the floor
 *                     would have been without intervention, and by what means (locks / deferred covers /
 *                     offsets / blocked opens).
 *
 * Usage: node scripts/candle-spread/report-baselines.js [path/to/backtest-baselines.json]
 */
const fs = require('fs');
const path = require('path');

const DEF = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json');
const FILE = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : DEF;

// ── DIFF MODE ───────────────────────────────────────────────────────────────────────────────────────
//   node report-baselines.js --diff <previous.json> [current.json]
// A rebaseline changes what the strategies ARE, so the review question is "what moved, on every metric
// that matters" — not just the running total. Totals alone are actively misleading once a day-loss cap is
// in play: a capped variant is SUPPOSED to give up total, and `worst` stops being informative because it
// is pinned to the ceiling by construction. What actually distinguishes configurations is the AVERAGE day
// — the floor it holds (avgWorstCase: the minimum of the day's terminal curve; POSITIVE means the book
// cannot lose) and the peak it carries (avgBestCase / avgTerminalPotential) — plus win rate, payoff and
// drawdown. Print those side by side or the comparison is not a comparison.
const di = process.argv.indexOf('--diff');
if (di >= 0) {
  const prevPath = process.argv[di + 1];
  if (!prevPath) { console.error('usage: report-baselines.js --diff <previous.json> [current.json]'); process.exit(1); }
  const A = JSON.parse(fs.readFileSync(path.resolve(prevPath), 'utf8'));
  const B = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const usd = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
  const d = (a, b, f) => { const x = (b == null ? 0 : b) - (a == null ? 0 : a); return (x >= 0 ? '+' : '') + (f ? f(x) : x); };
  const rows = Object.keys(B.variants)
    .filter((v) => A.variants[v] && JSON.stringify(A.variants[v]) !== JSON.stringify(B.variants[v]))
    .map((v) => ({ v, a: A.variants[v], b: B.variants[v] }))
    .sort((x, y) => (y.b.total - y.a.total) - (x.b.total - x.a.total));
  console.log(`\nBASELINE DIFF — ${rows.length} variant(s) changed · ${A.days}d -> ${B.days}d`);
  console.log('avgFloor = avgWorstCase, the mean day\'s WORST terminal outcome (>0 = the book cannot lose that day)');
  console.log('avgPeak  = avgBestCase, the mean day\'s BEST terminal outcome · avgTerm = mean terminal potential\n');
  const H = 'variant'.padEnd(11) + 'total'.padStart(13) + 'Δtotal'.padStart(13)
    + 'avgFloor'.padStart(11) + 'Δ'.padStart(9) + 'avgPeak'.padStart(10) + 'Δ'.padStart(9)
    + 'avgTerm'.padStart(10) + 'win%'.padStart(7) + 'payoff'.padStart(8)
    + 'worst'.padStart(10) + 'maxDD30'.padStart(11) + 'eff'.padStart(8);
  console.log(H); console.log('-'.repeat(H.length));
  for (const r of rows) {
    console.log(r.v.padEnd(11)
      + usd(r.b.total).padStart(13) + d(r.a.total, r.b.total, usd).padStart(13)
      + usd(r.b.avgWorstCase).padStart(11) + d(r.a.avgWorstCase, r.b.avgWorstCase, usd).padStart(9)
      + usd(r.b.avgBestCase).padStart(10) + d(r.a.avgBestCase, r.b.avgBestCase, usd).padStart(9)
      + usd(r.b.avgTerminalPotential).padStart(10)
      + (Math.round(r.b.winRate * 100) + '%').padStart(7)
      + String(r.b.payoff).padStart(8)
      + usd(r.b.worst).padStart(10) + usd(r.b.maxDD30).padStart(11)
      + String(r.b.efficiency).padStart(8));
  }
  // The bound check matters more than any P&L line once a cap is on: if the ceiling leaked, nothing else
  // in the table means anything.
  const leaked = rows.filter((r) => r.b.governor && r.b.governor.capExceeded > 0);
  console.log('');
  console.log(leaked.length
    ? `⚠️  CAP LEAKED on ${leaked.length}: ` + leaked.map((r) => `${r.v} (${r.b.governor.capExceeded} days)`).join(', ')
    : '✅ cap held on every changed variant (capExceeded 0)');
  process.exit(0);
}
if (!fs.existsSync(FILE)) { console.error('no baselines file at ' + FILE); process.exit(1); }
const B = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const V = B.variants;

const usd = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const k = n => (n == null ? '—' : (n < 0 ? '-' : '') + '$' + (Math.abs(n) / 1000).toFixed(0) + 'k');
const retDD = v => (v.maxDD30 ? v.total / Math.abs(v.maxDD30) : 0);

console.log(`${B.days} trading days · ${Object.keys(V).length} variants · generated ${B.generatedAt}`);
console.log(`${path.relative(process.cwd(), FILE)}\n`);

const gov = Object.entries(V).filter(([, v]) => v.governor);
if (gov.length) {
  const bad = gov.filter(([, v]) => v.governor.capExceeded > 0);
  console.log('=== BOUND CHECK ===');
  console.log(bad.length === 0
    ? `✓ 0 days worse than lossMax across ${gov.length} governed variants x ${B.days} days`
    : `✗ ${bad.map(([n, v]) => n + ' x' + v.governor.capExceeded).join(', ')}`);
  const tight = gov.map(([n, v]) => ({ n, slack: -v.governor.lossMax - v.worst })).sort((a, b) => a.slack - b.slack).slice(0, 3);
  console.log('closest to the ceiling: ' + tight.map(x => `${x.n} (${usd(x.slack)} spare)`).join(' · '));
}

console.log('\n=== CAPPED vs UNCAPPED (what the governor costs each family) ===');
console.log('variant'.padEnd(9) + 'CAPPED total'.padStart(13) + 'worst'.padStart(9) + 'maxDD30'.padStart(9) + 'ret/DD'.padStart(7)
  + '  |' + 'UNCAPPED total'.padStart(15) + 'worst'.padStart(10) + 'maxDD30'.padStart(9) + 'ret/DD'.padStart(7) + '  keep%');
const FAMS = [...new Set(Object.keys(V).map(n => n.split('-')[0]))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
for (const f of FAMS) for (const w of [10, 20, 40]) {
  const c = V[`${f}-${w}`], u = V[`${f}-${w}-unc`];
  if (!c || !u) continue;
  console.log(`${f}-${w}`.padEnd(9) + usd(c.total).padStart(13) + usd(c.worst).padStart(9) + k(c.maxDD30).padStart(9) + retDD(c).toFixed(1).padStart(7)
    + '  |' + usd(u.total).padStart(15) + usd(u.worst).padStart(10) + k(u.maxDD30).padStart(9) + retDD(u).toFixed(1).padStart(7)
    + '  ' + (u.total > 0 ? (c.total / u.total * 100).toFixed(0) + '%' : '—').padStart(5));
}

if (gov.length) {
  console.log('\n=== BEST UNDER THE GOVERNOR (by return/drawdown) ===');
  gov.map(([n, v]) => ({ n, v, r: retDD(v) })).sort((a, b) => b.r - a.r).slice(0, 10).forEach((x, i) =>
    console.log(`${String(i + 1).padStart(2)}. ${x.n.padEnd(12)} total ${usd(x.v.total).padStart(11)} · avg/day ${usd(x.v.avgDaily).padStart(7)}`
      + ` · worst ${usd(x.v.worst).padStart(8)} (cap ${usd(-x.v.governor.lossMax)}) · maxDD30 ${k(x.v.maxDD30).padStart(6)}`
      + ` · ret/DD ${x.r.toFixed(1).padStart(5)} · win ${Math.round(x.v.winRate * 100)}%`));

  console.log('\n=== BEST BY TOTAL (governed) ===');
  [...gov].sort((a, b) => b[1].total - a[1].total).slice(0, 8).forEach(([n, v], i) =>
    console.log(`${String(i + 1).padStart(2)}. ${n.padEnd(12)} ${usd(v.total).padStart(11)} · worst ${usd(v.worst).padStart(8)}`
      + ` · maxDD30 ${k(v.maxDD30).padStart(6)} · ret/DD ${retDD(v).toFixed(1)}`));

  console.log('\n=== GOVERNOR ACTIVITY ===');
  for (const n of ['v6-10', 'v6-20', 'v6-40', 'v4-20', 'v9-20', 'v9-40']) {
    const v = V[n]; if (!v || !v.governor) continue;
    const g = v.governor;
    console.log(n.padEnd(8) + `held ${usd(g.worstHeldFloor).padStart(8)}/${usd(-g.lossMax).padStart(8)}`
      + ` · pre-reduction ${usd(g.worstFloorPreReduction).padStart(9)} · locks ${String(g.floorCovers).padStart(5)}`
      + ` · deferred ${String(g.coversDeferred).padStart(5)} · offsets ${String(g.offsets).padStart(4)} · blocked ${g.opensBlocked}`);
  }
}
