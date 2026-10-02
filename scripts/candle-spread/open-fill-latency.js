#!/usr/bin/env node
'use strict';
/**
 * open-fill-latency.js — how do REAL orders actually get filled?
 *
 * The backtest has to choose a fill rule for opens (openFillModel), and the two it has disagree by more
 * than half of v7-10's daily P&L: 'immediate' books at the decision price, 'ladder' (83e546e) can never
 * fill in the bar the order was placed in. The first real session (2026-10-02) filled 5 of 5 opens within
 * 33 seconds — so the truth is in between, and only live data can say where. This measures it.
 *
 * REAL ORDERS ONLY: rows sent with testMode false. Simulated variants book fills off the chain mark, which
 * says nothing about the broker, and test-mode orders are priced never to fill.
 *
 * Reads candle-spread-archive/ (run scripts/sync-candle-spread-runs.js first). Read-only.
 *
 * TIMING PRECISION: the fill time is when the server's order poll SAW the fill (every ~20s, skipped while a
 * tick runs), not Schwab's execution time — each time-to-fill can read up to ~20-25s late. Fine for the
 * question that matters (did it fill inside its 5-minute placement bar?), coarse for sub-minute detail.
 *
 * Usage:
 *   node scripts/candle-spread/open-fill-latency.js                    # every day with real orders
 *   node scripts/candle-spread/open-fill-latency.js --from 2026-10-05 [--to 2026-10-09]
 *   node scripts/candle-spread/open-fill-latency.js --variant v7-10
 *   node scripts/candle-spread/open-fill-latency.js --covers           # resting covers instead of opens
 *   node scripts/candle-spread/open-fill-latency.js --quiet            # summary only, no per-order rows
 */
const fs = require('fs');
const path = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = arg('--from', null), TO = arg('--to', null), ONLY = arg('--variant', null);
const COVERS = process.argv.includes('--covers');
const QUIET = process.argv.includes('--quiet');
const AR = arg('--dir', path.join(__dirname, '..', '..', 'candle-spread-archive'));

const BAR_MS = 5 * 60 * 1000;
// The order kinds that START a chain, and the kinds a replace produces for it.
const ROOT = COVERS ? /^cover-rest$/ : /^open$/;
const WHAT = COVERS ? 'resting covers' : 'opens';

const ms = (iso) => Date.parse(iso);
const et = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const quant = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const med = (xs) => quant(xs, 0.5);

// runId = SYMBOL_EXPIRATION_TRADEDATE[_VARIANT]
function parseName(f) {
  const m = /^([A-Z$]+)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:_(.+))?\.json$/.exec(f);
  return m ? { symbol: m[1], date: m[3], variant: m[4] || null } : null;
}

// One chain per placed order: the root send plus every replacement, with how it ended.
function chainsFor(rec) {
  const ev = rec.events || [];
  const chains = [];
  const byId = new Map();                 // any order id in a chain -> that chain
  const candles = ev.filter((e) => e.type === 'candle_close' && e.underlying != null)
    .map((e) => ({ t: ms(e.time), u: Number(e.underlying) }));
  const underAt = (t) => { let u = null; for (const c of candles) { if (c.t <= t + 15000) u = c.u; else break; } return u; };
  const underAfter = (t) => { for (const c of candles) if (c.t >= t) return c.u; return null; };

  for (const e of ev) {
    const m = e.meta || {};
    if (e.type === 'order_sent' && e.testMode === false && ROOT.test(m.kind || '') && e.orderId) {
      const t = ms(e.time);
      const net = (m.net || 'DEBIT').replace(/^NET_/, '');
      // meta.mark is the DEBIT-canonical mark; show it in the space the order was SENT in, so a credit row
      // compares like with like (twin credit = width - debit mark).
      const ks = (m.legs || []).map((l) => l.strike), width = ks.length ? Math.max(...ks) - Math.min(...ks) : null;
      const mark = m.mark == null ? null : (net === 'CREDIT' && width ? r2(width - Number(m.mark)) : Number(m.mark));
      // covers carry no side; it is the side of the position they cover
      const pos = ((rec.state && rec.state.positions) || []).find((p) => p && p.id === m.of);
      const c = { root: e.orderId, ids: [e.orderId], placedT: t, side: m.side || (pos && pos.side) || null, net,
        placed: Number(e.payload && e.payload.price), mark, legs: m.legs || [],
        reprices: 0, prices: [Number(e.payload && e.payload.price)], outcome: 'expired', fillT: null, fill: null,
        under0: underAt(t), positionId: m.of || null };
      chains.push(c); byId.set(e.orderId, c);
    } else if (e.type === 'order_replaced' && e.testMode === false && byId.has(e.orderId)) {
      const c = byId.get(e.orderId);
      if (e.newOrderId && e.newOrderId !== e.orderId) { c.ids.push(e.newOrderId); byId.set(e.newOrderId, c); }
      c.reprices++; c.prices.push(Number(e.payload && e.payload.price));
    }
  }
  for (const e of ev) {
    const c = e.orderId && byId.get(e.orderId);
    if (!c) {
      // a strategy cancel is logged as a decision on the position, carrying the order id
      for (const d of e.decisions || []) {
        const cc = d.orderId && byId.get(d.orderId);
        if (cc && d.action === 'cancel-open' && cc.outcome === 'expired') { cc.outcome = 'canceled-reversal'; cc.endT = ms(e.time); }
      }
      continue;
    }
    if (e.type === 'order_filled' && c.fillT == null) {
      c.outcome = 'filled'; c.fillT = ms(e.time); c.fill = Number(e.fillPrice); c.fillSide = e.fillSide || null;
      if (e.orderId === c.root && c.ids.length > 1) c.filledOriginal = true;   // the replace race: the original won
    } else if (c.outcome === 'expired') {
      if (e.type === 'order_cancelled') { c.outcome = /reversal/.test((e.meta && e.meta.reason) || '') ? 'canceled-reversal' : 'canceled-strategy'; c.endT = ms(e.time); }
      else if (e.type === 'order_canceled') { c.outcome = e.reason === 'stale-open' ? 'canceled-stale' : 'canceled-' + (e.reason || 'other'); c.endT = ms(e.time); }
      else if (e.type === 'order_dead' && e.reason !== 'replaced' && e.reason !== 'superseded-by-fill' && e.orderId === c.ids[c.ids.length - 1]) {
        c.outcome = e.status === 'rejected' ? 'rejected' : 'dead-' + (e.status || 'unknown'); c.endT = ms(e.time);
      }
    }
  }
  for (const c of chains) {
    c.barEnd = Math.floor(c.placedT / BAR_MS) * BAR_MS + BAR_MS;   // the next 5-minute boundary
    if (c.fillT != null) {
      c.latency = Math.round((c.fillT - c.placedT) / 1000);
      c.inBar = c.fillT < c.barEnd;
      c.bars = Math.floor((c.fillT - c.barEnd) / BAR_MS) + 1;     // 0 = placement bar, 1 = next bar, ...
      // CONCESSION: what we gave up against the price we first asked. A debit pays more; a credit takes less.
      c.concession = r2(c.net === 'CREDIT' ? c.placed - c.fill : c.fill - c.placed);
      c.under1 = underAfter(c.fillT);
    }
  }
  return chains;
}

// ── collect ────────────────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(AR)) { console.error(`no archive at ${AR} — run scripts/sync-candle-spread-runs.js first`); process.exit(1); }
const files = fs.readdirSync(AR).filter((f) => f.endsWith('.json')).map((f) => ({ f, ...parseName(f) }))
  .filter((x) => x.date && x.variant && (!FROM || x.date >= FROM) && (!TO || x.date <= TO) && (!ONLY || x.variant === ONLY))
  .sort((a, b) => (a.date + a.variant).localeCompare(b.date + b.variant));

const all = [];
for (const x of files) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(AR, x.f), 'utf8')); } catch (e) { continue; }
  // cheap pre-filter: a record with no real send is a simulated or test-mode run
  if (!(rec.events || []).some((e) => e.type === 'order_sent' && e.testMode === false)) continue;
  for (const c of chainsFor(rec)) all.push({ ...c, date: x.date, variant: x.variant });
}

if (!all.length) {
  console.log(`no real-money ${WHAT} found in ${AR}${FROM ? ` from ${FROM}` : ''}${TO ? ` to ${TO}` : ''}${ONLY ? ` for ${ONLY}` : ''}.`);
  process.exit(0);
}

// ── per-order rows ─────────────────────────────────────────────────────────────────────────────────
if (!QUIET) {
  console.log(`\nREAL ${WHAT.toUpperCase()} — one row per placed order (times ET; fill time = when the poll saw it, up to ~20s late)\n`);
  const head = ['date', 'variant', 'placed', 'side', 'net', 'placed$', 'mark', 'reprices', 'outcome', 'fill$', 'concede', 'secs', 'bar', 'NDX@place', 'NDX@fill~'];
  const rows = all.map((c) => [c.date, c.variant, et(c.placedT), c.side || '', c.net, c.placed.toFixed(2),
    c.mark != null ? c.mark.toFixed(2) : '', String(c.reprices), c.outcome + (c.filledOriginal ? '*' : ''),
    c.fill != null ? c.fill.toFixed(2) : '', c.concession != null ? (c.concession >= 0 ? '+' : '') + c.concession.toFixed(2) : '',
    c.latency != null ? String(c.latency) : '', c.fillT != null ? (c.inBar ? 'same' : '+' + c.bars) : '',
    c.under0 != null ? c.under0.toFixed(0) : '', c.under1 != null ? c.under1.toFixed(0) : '']);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((s, i) => (i < 5 || i === 8 ? s.padEnd(w[i]) : s.padStart(w[i]))).join('  ');
  console.log(line(head)); console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
  if (all.some((c) => c.filledOriginal)) console.log('\n  * the ORIGINAL order filled while its replacement was pending (replace race)');
  console.log('  concede = what we gave up vs the first price asked (debit: paid more, credit: received less), per share');
  console.log('  bar = filled in the 5-minute placement bar ("same") or N bars later; NDX@fill~ = first 5m close after the fill');
}

// ── summary ────────────────────────────────────────────────────────────────────────────────────────
function summarize(label, cs) {
  if (!cs.length) return;
  const filled = cs.filter((c) => c.fillT != null);
  const lat = filled.map((c) => c.latency);
  const con = filled.map((c) => c.concession);
  const inBar = filled.filter((c) => c.inBar);
  const atPlaced = filled.filter((c) => c.concession <= 0.001);
  const outcomes = {};
  for (const c of cs) outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
  console.log(`\n${label}  (${cs.length} placed)`);
  console.log(`  outcomes        ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  fill rate       ${pct(filled.length, cs.length)}  (${filled.length}/${cs.length})`);
  if (!filled.length) return;
  console.log(`  time to fill    median ${med(lat)}s · p90 ${quant(lat, 0.9)}s · max ${Math.max(...lat)}s`);
  console.log(`  in placement bar ${pct(inBar.length, filled.length)} of fills · within one more bar ${pct(filled.filter((c) => c.bars <= 1).length, filled.length)}`);
  console.log(`  at placed price ${pct(atPlaced.length, filled.length)} of fills · needed a reprice ${pct(filled.filter((c) => c.reprices > 0).length, filled.length)}`);
  console.log(`  concession      avg ${r2(con.reduce((a, b) => a + b, 0) / con.length).toFixed(2)} · p90 ${quant(con, 0.9).toFixed(2)} · worst ${Math.max(...con).toFixed(2)}  (per share; x100 = $/spread)`);
}

const days = [...new Set(all.map((c) => c.date))];
console.log(`\n══ SUMMARY — real ${WHAT}, ${days.length} day(s) ${days[0]}..${days[days.length - 1]}, variants: ${[...new Set(all.map((c) => c.variant))].join(', ')} ══`);
summarize('ALL', all);
summarize('DEBIT-sent', all.filter((c) => c.net === 'DEBIT'));
summarize('CREDIT-sent', all.filter((c) => c.net === 'CREDIT'));
summarize('bull', all.filter((c) => c.side === 'bull'));
summarize('bear', all.filter((c) => c.side === 'bear'));

// ── what this says about the backtest fill rule ────────────────────────────────────────────────────
if (!COVERS) {
  const filled = all.filter((c) => c.fillT != null);
  const n = all.length;
  const inBar = filled.filter((c) => c.inBar);
  const p90InBar = inBar.length ? quant(inBar.map((c) => c.concession), 0.9) : null;
  console.log('\n══ IMPLICATION FOR THE BACKTEST OPEN FILL RULE ══');
  console.log(`  ${pct(inBar.length, n)} of placed opens filled INSIDE their placement bar`
    + (p90InBar != null ? `, 90% of those at <= placed + $${p90InBar.toFixed(2)}/share` : '') + '.');
  console.log(`  'immediate' assumes 100% in-bar at the placed price; 'ladder' (83e546e) assumes 0% in-bar.`);
  console.log(`  ${pct(filled.length - inBar.length, n)} filled in a LATER bar (the ladder model's case); `
    + `${pct(n - filled.length, n)} never filled.`);
  if (n < 50) console.log(`  CAUTION: ${n} orders is a small sample — collect ~50-100 before choosing the rule.`);
}
console.log('');
