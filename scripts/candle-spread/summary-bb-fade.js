'use strict';
// Builds summary.md for the v20 / v21 BB-fade sweep (sweep-v10.js --bbFade) from sweep.json.
// Usage: node scripts/candle-spread/summary-bb-fade.js data/sweeps/bb-fade-v20-v21-2026-10-21
const fs = require('fs'), path = require('path');
const dir = process.argv[2];
const { meta, rows } = JSON.parse(fs.readFileSync(path.join(dir, 'sweep.json'), 'utf8'));
const f = (n) => (n == null ? '' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const pad = (s, n) => String(s == null ? '' : s).padStart(n);
const hdr = 'variant           worst  maxDD30  IF avg  IF>=0%  endFl locked  uncov/d  sig/d  placed/d filled/d  opens/d  avg/d        total';
const line = (r, x) => `${r.variant.padEnd(15)} ${pad(f(x.worst), 7)} ${pad(f(x.maxDD30), 8)} ${pad(f(x.intradayFloorAvg), 7)} ${pad(x.ifNonNegPct, 7)} ${pad(f(x.avgEndFloor), 6)} ${pad(x.lockedPct, 6)} ${pad(x.uncoveredEodPerDay, 8)} ${pad(x.signalsPerDay != null ? x.signalsPerDay : '-', 6)} ${pad(x.openPlacedPerDay, 8)} ${pad(x.openFilledPerDay, 8)} ${pad(x.opensPerDay, 8)} ${pad(f(x.avgDaily), 6)} ${pad(f(x.total), 12)}`;
const order = (v) => { const m = /^v(\d+)-(\d+)(?:-(cATM|f\d+))?(-unc)?/.exec(v); return m ? [Number(m[2]), m[3] && m[3].startsWith('f') ? 1 : m[3] ? 2 : 0, Number(m[1]), (m[3] || '') + (m[4] || '')] : [0, 0, 0, v]; };
const sorted = [...rows].sort((a, b) => { const x = order(a.variant), y = order(b.variant); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
const OO = rows.some((r) => r.arm === 'opensOnly');
const capHdr = '  bind%  blk/d walk/d 1stBlk pkCapMed pkCapMax';
const capCols = (x) => x.capBindPct == null ? '' : `  ${pad(x.capBindPct, 5)} ${pad(x.capBlockedPerDay, 6)} ${pad(x.capWalkBlockedPerDay, 6)} ${pad(x.capFirstBlockMedian || '-', 6)} ${pad(f(x.peakCapitalMedian), 8)} ${pad(f(x.peakCapitalMax), 8)}`;
const out = [];
out.push(`# BB FADE v20 / v21${OO ? ' — OPENS ONLY' : ''} — ${meta.days} days ${meta.from}..${meta.to} (${meta.n2026} NDX-priced 2026 days)\n`);
out.push('Signal (NQ 24h, every 5m close): close below BOTH the 15m and 60m lower BB(20,2) -> bull; above BOTH uppers -> bear.');
out.push('Bands = last COMPLETED 15m / 60m bar as of the 5m close (analysis-builder completedAsOf). v20 = v9 strike placement;');
out.push('v21 = strike whose BS mark is closest to f x W (nearest the money on a tie), walk cap = f + (v9 capFrac - 0.50).');
if (OO) {
  out.push('OPENS ONLY (backtest/opens-only.js): no covers or hedges of any kind; every open held to the settle. Kept: risk cap (governor');
  out.push('lossMax on the projected book floor; -unc = none), open walk ladder, placement, leg ledger. v9 rows = unchanged roster controls.');
  out.push('bind% = days the cap refused >= 1 open; blk/d = signal opens refused by the cap; walk/d = ladder steps refused by the cap;');
  out.push('1stBlk = median ET time of the first refusal (days with one); pkCap = peak sum of open debits held ($, = max-loss sum).');
} else {
  out.push('Everything after the open = v9 roster machinery (optsFor, ladder opens, 1m sub-bar fills, risk cap). v9 rows = controls.');
}
out.push('sig/d = qualifying 5m closes 09:30-15:55 ET; placed/d / filled/d = signal opens the ladder placed / filled (after one-working-open,');
out.push('caps, governor); opens/d = every position booked incl. hedges and wings (the baselines opens/day definition).\n');
for (const [era, key] of [['All days', 'all'], ['2026 only (NDX-priced days)', 'y2026']]) {
  out.push(`## ${era}\n\n\`\`\`\n${hdr}${OO ? capHdr : ''}`);
  let lastW = null;
  for (const r of sorted) { if (!r[key]) continue; const w = order(r.variant)[0]; if (lastW != null && w !== lastW) out.push(''); lastW = w; out.push(line(r, r[key]) + (OO ? capCols(r[key]) : '')); }
  out.push('```\n');
}
fs.writeFileSync(path.join(dir, 'summary.md'), out.join('\n'));
console.log(out.join('\n'));
