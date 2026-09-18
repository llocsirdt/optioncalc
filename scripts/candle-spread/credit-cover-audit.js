#!/usr/bin/env node
'use strict';
/**
 * credit-cover-audit.js — did credit-style covers ask the right price, and did that change their fill rate?
 *
 * WHY. Until 2096509 the two cover branches answered different questions. A DEBIT cover rests at the
 * profit-LOCK target (W - openCost - minLock), a price chosen to bank a result; the CREDIT twin was
 * priced at its own chain MARK, a price chosen to trade. Parity says the twin must ask W - target, so
 * pricing it off the mark asked for systematically LESS credit — it filled too easily and locked less
 * than the book recorded, while the debit-canonical record looked fine.
 *
 * BASELINE, 2026-09-17, the last session before the fix:
 *     CREDIT covers  placed 378  filled 284   75.1%
 *     DEBIT  covers  placed 952  filled 691   72.6%
 *     credit asked short of its lock target: all 378, mean 5.74 pts, max 26.70
 * Credit covers filling MORE often than debit ones is the tell: they were the cheaper order to fill.
 *
 * THE PREDICTION the fix makes, and this script is how it gets checked:
 *   1. `mean short by` collapses to ~0.00 — by construction, since the twin is now derived as W - debit.
 *   2. The CREDIT fill rate FALLS, and should land at or below the debit rate rather than above it.
 * If (1) holds and (2) does not, the twin is priced right and something else drives the fill difference.
 *
 * Usage: node scripts/candle-spread/credit-cover-audit.js [--date YYYY-MM-DD] [--dir <run json dir>]
 *        --dir defaults to the local archive, which the run-sync LaunchAgent fills after each close.
 */
const fs = require('fs');
const path = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DATE = arg('--date', null);
const DIR = arg('--dir', path.join(__dirname, '..', '..', 'candle-spread-archive'));

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && (!DATE || f.includes(DATE)));
if (!files.length) { console.error(`no run files in ${DIR}${DATE ? ` for ${DATE}` : ''}`); process.exit(1); }

let placedC = 0, placedD = 0, filledC = 0, filledD = 0;
const gaps = [];
for (const f of files) {
  let rec;
  try { const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); rec = j.run || j; } catch (e) { continue; }
  if (!rec || !rec.state) continue;
  // The cover order actually SENT, per position, and the lock target it was derived from.
  const sent = new Map(), targets = new Map();
  for (const e of rec.events || []) {
    if ((e.type === 'order_simulated' || e.type === 'order_sent') && e.meta && e.meta.of
      && /cover/.test(e.meta.kind || '')) sent.set(e.meta.of, e.meta);
    for (const d of (e.decisions || [])) {
      if (d.action === 'cover-rest' && d.target != null) targets.set(d.positionId, d.target);
    }
  }
  for (const [id, meta] of sent) {
    const pos = (rec.state.positions || []).find((p) => p.id === id);
    if (!pos) continue;
    const isCredit = meta.net === 'CREDIT';
    if (isCredit) { placedC++; if (pos.covered) filledC++; } else { placedD++; if (pos.covered) filledD++; }
    if (isCredit && meta.limit != null) {
      const t = targets.get(id);
      if (t != null && meta.legs && meta.legs.length) {
        const ks = meta.legs.map((l) => l.strike);
        const W = Math.max(...ks) - Math.min(...ks);
        gaps.push(Math.round(((W - t) - meta.limit) * 100) / 100);   // credit we failed to ask for
      }
    }
  }
}
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');
const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
const over = gaps.filter((g) => g > 0.05).length;
console.log(`CREDIT COVER AUDIT — ${DATE || 'all dates'} (${files.length} run files)\n`);
console.log(`  CREDIT covers  placed ${placedC}  filled ${filledC}   fill rate ${pct(filledC, placedC)}`);
console.log(`  DEBIT  covers  placed ${placedD}  filled ${filledD}   fill rate ${pct(filledD, placedD)}`);
console.log(`\n  credit asked SHORT of its lock target: ${over} of ${gaps.length}`);
console.log(`    mean ${mean.toFixed(2)} pts   max ${(gaps.length ? Math.max(...gaps) : 0).toFixed(2)} pts`
  + `   (~$${Math.round(mean * 100).toLocaleString()}/contract)`);
console.log('\n  vs the 2026-09-17 pre-fix baseline: CREDIT 75.1% · DEBIT 72.6% · mean short 5.74');
if (Math.abs(mean) < 0.1) console.log('  => the twin is now priced at parity, as intended.');
else console.log('  => still mispriced; the twin is NOT being derived from the debit price.');
