'use strict';
// END-TO-END: the real live engine over a real session (scripts/candle-spread/replay-live-day.js), 2026-11-05.
// That day NDX fell ~1,370 points and left the band where 10-point strikes were listed (27,260-28,070). Checks:
//   - every 5m tick ran (a thin strike grid must never skip a tick: strike-grid.js / tradability.js, 2026-11-05);
//   - 20W traded 20W while the 10s existed and 25W after (fallback width), 10W stopped opening (open-skip-grid);
//   - with NDX frozen from 13:00 (the 2026-09-07 Labor Day failure), the price-freshness check reports would-block
//     in SHADOW mode and still blocks nothing (c8f7b2b).
// Skips when the 11-05 raw 1m data is not on this machine. ~10 s.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const RAW = path.join(ROOT, 'signal-lab-data', 'raw-1m');
if (!fs.existsSync(path.join(RAW, 'NDX-2026-11-05.json')) || !fs.existsSync(path.join(RAW, 'NQ-2026-11-05.json'))) {
  console.log('11-05 raw 1m data absent — skipped\n\n0 passed, 0 failed'); process.exit(0);
}
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-e2e-')), 'r.json');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/candle-spread/replay-live-day.js'), '--date', '2026-11-05',
  '--tens', '27260-28070', '--variants', 'v7-10,v7-20', '--freeze-after', '13:00', '--json', out],
{ cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], timeout: 180000 });
const j = JSON.parse(fs.readFileSync(out, 'utf8'));
const by = Object.fromEntries(j.runs.map((r) => [r.variant, r]));
ok(j.ticks.acted === 78 && Object.keys(j.ticks.pending).length === 0, `every tick ran (${j.ticks.acted}/78, pending ${JSON.stringify(j.ticks.pending)})`);
ok(j.ticks.notTradable === 0, 'the sparse grid never made the market "not tradable"');
ok(by['v7-20'] && by['v7-20'].widths['20'] > 0 && by['v7-20'].widths['25'] > 0, `v7-20 traded 20W then 25W (${JSON.stringify(by['v7-20'] && by['v7-20'].widths)})`);
ok(by['v7-20'].fallbackOpens > 0, 'v7-20 recorded fallback-width opens');
ok(by['v7-10'] && Object.keys(by['v7-10'].widths).join() === '10' && by['v7-10'].skipGrid > 0, `v7-10 only ever traded 10W and stopped on the 25 grid (skip-grid ${by['v7-10'] && by['v7-10'].skipGrid})`);
ok(by['v7-20'].terminal != null && by['v7-10'].terminal != null, 'both runs settled');
ok(j.ticks.freshnessMode === 'shadow', 'the price-freshness check runs in shadow mode');
ok(j.ticks.freshnessWouldBlock > 20, `a frozen NDX is flagged would-block (${j.ticks.freshnessWouldBlock} ticks after 13:10)`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
