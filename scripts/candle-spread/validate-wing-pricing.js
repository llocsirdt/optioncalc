#!/usr/bin/env node
'use strict';
/**
 * validate-wing-pricing.js — does the BACKTEST price a WING the way the real chain does?
 *
 * The wing-conversion overlay (wing-convert.js) buys OTM debit spreads, and in backtest it prices them
 * with flat-IV Black-Scholes + a per-leg slip:  cost = BS_spread(iv) + 2*slip.  Live it uses real quotes.
 * Wings are bought precisely where a single-IV model is weakest — out of the money, where SKEW lives — so
 * the aggregate wing results are only trustworthy if that pricing is close. This measures it against every
 * captured chain snapshot we have (candle-spread-archive/*.json → events[].chainSnapshot, real bid/ask).
 *
 * REAL cost is the MARKETABLE one you would actually pay: buy the long leg at the ASK, sell the short at
 * the BID. Two tests, because they answer different questions:
 *
 *   TEST A — END-TO-END (calibration days only). iv = perDayBandIV × ivMult(timeOfDay), i.e. exactly the
 *     number runDay5m feeds BS when intradayIV is on. Answers "is the shipped wing price right?"
 *   TEST B — SKEW ISOLATION (all days). iv = the REAL ATM implied vol backed out of the same snapshot.
 *     Handing the model the correct ATM vol means any residual error is PURE SKEW error — the part no
 *     single-IV model can represent, and the part that matters most for OTM wings.
 *
 * Usage: node scripts/candle-spread/validate-wing-pricing.js [--slip 0.25] [--widths 10,20,40]
 */
const fs = require('fs');
const path = require('path');
const bs = require('../../server/src/candle-spread/bs-pricer');

const ARCHIVE = path.join(__dirname, '..', '..', 'candle-spread-archive');
const CORR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'intraday-iv-correction.json'), 'utf8'));
const argN = (flag, d) => { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SLIP = argN('--slip', 0.25);
const WI = process.argv.indexOf('--widths');
const WIDTHS = WI >= 0 ? process.argv[WI + 1].split(',').map(Number) : [10, 20, 40];

// ivMult(t) by linear interpolation — mirrors backtest-v6-5m.ivMultAt exactly.
const MULT = Object.entries(CORR.perBucket).map(([k, m]) => { const [h, mm] = k.split(':').map(Number); return { min: h * 60 + mm, mult: m }; })
  .filter(x => x.mult != null).sort((a, b) => a.min - b.min);
function ivMultAt(t) {
  if (!MULT.length) return 1;
  if (t <= MULT[0].min) return MULT[0].mult;
  if (t >= MULT[MULT.length - 1].min) return MULT[MULT.length - 1].mult;
  for (let i = 1; i < MULT.length; i++) if (t <= MULT[i].min) { const p = MULT[i - 1], c = MULT[i]; return p.mult + (t - p.min) / (c.min - p.min) * (c.mult - p.mult); }
  return MULT[MULT.length - 1].mult;
}
const tauFromMins = m => Math.max(1e-6, (16 * 60 - m) / (365 * 24 * 60));
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const usd = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

// Collect one snapshot per (date, time) — every variant records the same chain, so dedupe.
const snaps = new Map();
for (const f of fs.readdirSync(ARCHIVE).filter(x => /^NDX_.*\.json$/.test(x))) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')); } catch (e) { continue; }
  const date = j.tradeDate;
  for (const e of j.events || []) {
    const cs = e.chainSnapshot;
    if (!cs || !cs.strikes || !e.candle) continue;
    const key = `${date}|${e.candle.time}`;
    if (snaps.has(key)) continue;
    const chain = {};
    for (const k of Object.keys(cs.strikes)) { const s = cs.strikes[k]; if (s && s.strike != null) chain[s.strike] = s; }
    const [hh, mm] = e.candle.time.split(' ')[1].split(':').map(Number);
    snaps.set(key, { date, time: e.candle.time, min: hh * 60 + mm, spot: cs.underlying, chain });
  }
}
const all = [...snaps.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
console.log(`WING PRICING VALIDATION — ${all.length} captured chain snapshots across ${new Set(all.map(s => s.date)).size} days · slip $${SLIP}/leg\n`);

// Back out the REAL ATM implied vol from the snapshot (high-vega → well identified).
function atmIv(s) {
  const ks = Object.keys(s.chain).map(Number).sort((a, b) => Math.abs(a - s.spot) - Math.abs(b - s.spot));
  const tau = tauFromMins(s.min);
  for (const k of ks.slice(0, 3)) {
    const q = s.chain[k];
    for (const [type, side] of [['C', 'call'], ['P', 'put']]) {
      const m = q[side] && q[side].mid;
      if (m > 0.5) { const v = bs.impliedVol(type, s.spot, k, tau, m); if (v > 0.01 && v < 3) return v; }
    }
  }
  return null;
}

// Every OTM wing candidate in a snapshot: real marketable cost vs model cost.
function samples(s, iv) {
  const out = [];
  const tau = tauFromMins(s.min);
  const ks = Object.keys(s.chain).map(Number).sort((a, b) => a - b);
  for (const w of WIDTHS) {
    for (const k of ks) {
      // upside wing: long call k, short call k+w   (both OTM → k >= spot)
      if (k >= s.spot && s.chain[k + w]) {
        const a = s.chain[k].call, b = s.chain[k + w].call;
        if (a && b && a.ask != null && b.bid != null) {
          const real = a.ask - b.bid, mid = a.mid - b.mid;
          const model = (bs.bsPrice('C', s.spot, k, tau, iv) + SLIP) - (bs.bsPrice('C', s.spot, k + w, tau, iv) - SLIP);
          const raw = bs.bsPrice('C', s.spot, k, tau, iv) - bs.bsPrice('C', s.spot, k + w, tau, iv);
          if (real > 0.02) out.push({ side: 'C', w, otm: k - s.spot, real, mid, raw, model, min: s.min, date: s.date });
        }
      }
      // downside wing: long put k, short put k-w   (both OTM → k <= spot)
      if (k <= s.spot && s.chain[k - w]) {
        const a = s.chain[k].put, b = s.chain[k - w].put;
        if (a && b && a.ask != null && b.bid != null) {
          const real = a.ask - b.bid, mid = a.mid - b.mid;
          const model = (bs.bsPrice('P', s.spot, k, tau, iv) + SLIP) - (bs.bsPrice('P', s.spot, k - w, tau, iv) - SLIP);
          const raw = bs.bsPrice('P', s.spot, k, tau, iv) - bs.bsPrice('P', s.spot, k - w, tau, iv);
          if (real > 0.02) out.push({ side: 'P', w, otm: s.spot - k, real, mid, raw, model, min: s.min, date: s.date });
        }
      }
    }
  }
  return out;
}

function report(title, rows) {
  if (!rows.length) { console.log(title, '— no samples\n'); return; }
  const err = rows.map(r => r.model - r.real);
  const rat = rows.map(r => r.model / r.real);
  console.log(title);
  console.log(`  n=${rows.length}  median model/real = ${med(rat).toFixed(2)}x   median error = ${usd(med(err) * 100)}/contract   (model − real; negative = backtest UNDER-prices the wing)`);
  const bucket = (label, f) => {
    const g = rows.filter(f);
    if (!g.length) return;
    const r = g.map(x => x.model / x.real), e = g.map(x => x.model - x.real);
    console.log(`    ${label.padEnd(22)} n=${String(g.length).padStart(5)}  model/real ${med(r).toFixed(2)}x   err ${usd(med(e) * 100).padStart(8)}   real median ${usd(med(g.map(x => x.real)) * 100).padStart(8)}`);
  };
  console.log('  by DISTANCE OTM:');
  bucket('0-20 pts', r => r.otm <= 20);
  bucket('20-50 pts', r => r.otm > 20 && r.otm <= 50);
  bucket('50-100 pts', r => r.otm > 50 && r.otm <= 100);
  bucket('>100 pts', r => r.otm > 100);
  console.log('  by SIDE:');
  bucket('calls (upside wing)', r => r.side === 'C');
  bucket('puts (downside wing)', r => r.side === 'P');
  console.log('  by TIME OF DAY:');
  bucket('before 12:00', r => r.min < 720);
  bucket('12:00-14:00', r => r.min >= 720 && r.min < 840);
  bucket('after 14:00', r => r.min >= 840);
  console.log('');
}

// ── TEST A — end-to-end, only on days the correction was calibrated from ──────────────────────────────
const calDays = new Set(CORR.meta.dates);
const rowsA = [];
for (const s of all) {
  const bandIv = CORR.meta.perDayBandIV[s.date];
  if (bandIv == null) continue;
  rowsA.push(...samples(s, bandIv * ivMultAt(s.min)));
}
report(`TEST A — END-TO-END shipped pricing (iv = perDayBandIV × ivMult), ${[...calDays].length} calibration days:`, rowsA);

// ── TEST B — skew isolation, every day incl. the two OUT-OF-SAMPLE ones ───────────────────────────────
const rowsB = [], rowsBout = [];
for (const s of all) {
  const iv = atmIv(s);
  if (!iv) continue;
  const r = samples(s, iv);
  rowsB.push(...r);
  if (!calDays.has(s.date)) rowsBout.push(...r);
}
report('TEST B — SKEW ISOLATION (model handed the REAL ATM vol), all days:', rowsB);
if (rowsBout.length) report('TEST B — same, restricted to days OUT-OF-SAMPLE for the IV correction:', rowsBout);

// ── what slip would make the model match reality? ─────────────────────────────────────────────────────
// ── FILL-ASSUMPTION SPLIT — the marketable number above assumes crossing BOTH legs. If NDX OTM spreads
// really fill near MID (the user's stated experience), the fair benchmark is the mid-to-mid cost, and the
// gap that matters is BS-vs-mid = pure SKEW, with the bid/ask crossing a separate, optional cost.
console.log('FILL ASSUMPTION — BS(ATM vol) vs the two benchmarks, no slip applied to either:');
for (const [lbl, f] of [['0-20 pts OTM', r => r.otm <= 20], ['20-50', r => r.otm > 20 && r.otm <= 50], ['50-100', r => r.otm > 50 && r.otm <= 100]]) {
  const g = rowsB.filter(f).filter(r => r.mid > 0.02);
  if (!g.length) continue;
  const vsMid = med(g.map(r => r.raw / r.mid)), vsAsk = med(g.map(r => r.raw / r.real));
  const halfSpread = med(g.map(r => (r.real - r.mid) / 2));
  console.log(`  ${lbl.padEnd(14)} n=${String(g.length).padStart(5)}  BS/mid ${vsMid.toFixed(2)}x   BS/marketable ${vsAsk.toFixed(2)}x   half-spread cost $${halfSpread.toFixed(2)}/leg  (median mid ${usd(med(g.map(r => r.mid)) * 100)})`);
}
console.log('');
console.log('IMPLIED SLIP — the per-leg add that would make BS(ATM vol) match the real marketable cost:');
for (const [lbl, f] of [['0-20 pts OTM', r => r.otm <= 20], ['20-50', r => r.otm > 20 && r.otm <= 50], ['50-100', r => r.otm > 50 && r.otm <= 100], ['>100', r => r.otm > 100]]) {
  const g = rowsB.filter(f);
  if (!g.length) continue;
  const need = g.map(r => (r.real - (r.model - 2 * SLIP)) / 2);   // solve real = BS + 2*slip'
  console.log(`  ${lbl.padEnd(14)} n=${String(g.length).padStart(5)}  median implied slip $${med(need).toFixed(2)}/leg  (shipped: $${SLIP.toFixed(2)})`);
}
