'use strict';
/**
 * E*TRADE transaction-export parser (pure; no I/O). Used by scripts/manual-trades/parse-etrade.js and
 * reusable by a later server endpoint. Two export formats are understood:
 *
 *  TIMED  (Transaction history, ~1 month):
 *    "<acct>, as of ..." / "Date / Time","Type","Account #","Account Name","Description","Fee","Comm","Amount"
 *    Description "1 Put NDXP 06/30/25 22640.00 @ $53.62 (Order # 20361)". Has a clock (export clock = ET+3h,
 *    verified) and true order numbers.
 *  DATED  (Account activity, longer range):
 *    preamble, then "Activity/Trade Date,Transaction Date,Settlement Date,Activity Type,Description,Symbol,
 *    Cusip,Quantity #,Price $,Amount $,Commission,Category,Note"; Description "PUT  NDXP   06/16/25 21300.000",
 *    Quantity signed. NO time of day and NO order numbers.
 *
 * Account number / name never leave parseExport: they are not columns of the normalized rows.
 *
 * Normalized row: { format, date, time|null, type, opt|null, qty (abs), price, amount, commListed, feeListed, orderNo|null, seq }
 *   opt = { root, right, expiry, strike } for option rows.
 */

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const money = s => {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '' || t === '--') return 0;
  const neg = /^-|\(/.test(t);
  const v = parseFloat(t.replace(/[^0-9.]/g, ''));
  return isFinite(v) ? (neg ? -v : v) : null;
};
const r2 = n => Math.round(n * 100) / 100;
const mdy = s => { const m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(String(s).trim()); if (!m) return null; return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1]}-${m[2]}`; };

// "06/30/2025 04:34:04 PM" -> { date:'2025-06-30', hms:'16:34:04', sec }
function parseStamp(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(String(s).trim());
  if (!m) return null;
  let h = +m[4] % 12; if (/PM/i.test(m[7])) h += 12;
  return { date: `${m[3]}-${m[1]}-${m[2]}`, hms: `${String(h).padStart(2, '0')}:${m[5]}:${m[6]}`, sec: h * 3600 + +m[5] * 60 + +m[6] };
}

const TIMED_RE = /^(\d+)\s+(Put|Call)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+([\d.]+)(?:\s+@\s+\$([\d,.]+))?(?:\s+\(Order\s*#\s*(\d+)\))?\s*$/i;
const DATED_RE = /^(PUT|CALL)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+([\d.]+)\s*$/i;

/** Parse a TIMED-format option description. */
function parseOptionDescription(desc) {
  const m = TIMED_RE.exec(String(desc).trim());
  if (!m) return null;
  return { qty: +m[1], right: /^c/i.test(m[2]) ? 'C' : 'P', root: m[3].toUpperCase(), expiry: mdy(m[4]), strike: +m[5],
    price: m[6] != null ? parseFloat(m[6].replace(/,/g, '')) : null, orderNo: m[7] || null };
}
/** Parse a DATED-format option description ("PUT  NDXP   06/16/25 21300.000"). */
function parseDatedDescription(desc) {
  const m = DATED_RE.exec(String(desc).trim());
  if (!m) return null;
  return { right: /^c/i.test(m[1]) ? 'C' : 'P', root: m[2].toUpperCase(), expiry: mdy(m[3]), strike: +m[4] };
}

function detectFormat(lines) {
  const t = lines.findIndex(l => /"?Date \/ Time"?\s*,\s*"?Type"?/i.test(l));
  if (t >= 0) return { format: 'timed', hi: t };
  const d = lines.findIndex(l => /^"?Activity\/Trade Date"?\s*,/i.test(l));
  if (d >= 0) return { format: 'dated', hi: d };
  throw new Error('unrecognized E*TRADE export (no known header row)');
}

/** Parse one export (either format) into normalized rows. */
function parseExport(text) {
  const lines = String(text).split(/\r?\n/);
  const { format, hi } = detectFormat(lines);
  const header = splitCsvLine(lines[hi]);
  const col = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const rows = [];
  let seq = 0;
  if (format === 'timed') {
    const iT = col('Date / Time'), iType = col('Type'), iD = col('Description'), iF = col('Fee'), iC = col('Comm'), iA = col('Amount');
    for (const l of lines.slice(hi + 1)) {
      if (!l.trim()) continue;
      const f = splitCsvLine(l);
      if (f.length < header.length) continue;
      const st = parseStamp(f[iT]);
      if (!st) continue;
      const o = parseOptionDescription(f[iD]);
      rows.push({ format, seq: seq++, date: st.date, time: st.hms, timeSec: st.sec, type: f[iType],
        opt: o ? { root: o.root, right: o.right, expiry: o.expiry, strike: o.strike } : null,
        qty: o ? o.qty : null, price: o ? o.price || 0 : null, orderNo: o ? o.orderNo : null,
        amount: money(f[iA]), feeListed: money(f[iF]), commListed: money(f[iC]), description: o ? null : f[iD] });
    }
  } else {
    const iDate = col('Activity/Trade Date'), iType = col('Activity Type'), iD = col('Description'), iQ = col('Quantity #'),
      iP = col('Price $'), iA = col('Amount $'), iC = col('Commission');
    for (const l of lines.slice(hi + 1)) {
      if (!/^\d{2}\/\d{2}\/\d{4},/.test(l)) continue;        // data rows only (skip the legal footer)
      const f = splitCsvLine(l);
      const o = parseDatedDescription(f[iD]);
      const q = money(f[iQ]);
      rows.push({ format, seq: seq++, date: mdy(f[iDate]), time: null, timeSec: null, type: f[iType],
        opt: o, qty: o ? Math.abs(q) : null, qtySigned: o ? q : null, price: o ? money(f[iP]) || 0 : null, orderNo: null,
        amount: money(f[iA]), feeListed: null, commListed: money(f[iC]), description: o ? null : f[iD] });
    }
  }
  return { format, rows };
}

const rowKey = r => [r.date, r.time, r.type, r.opt && `${r.opt.root}|${r.opt.right}|${r.opt.expiry}|${r.opt.strike}`, r.qty, r.price, r.orderNo, r.amount, r.description].join('|');
const isTrade = r => ['Bought To Open', 'Sold Short', 'Bought To Cover', 'Sold To Close'].includes(r.type);
const isSettle = r => r.type === 'Option Expired' || r.type === 'Sold';

/**
 * Combine several exports. Within one FORMAT, overlapping files repeat rows, and a row may also
 * legitimately repeat inside one file (identical partial fills) — so keep each distinct row's MAX
 * multiplicity in any single file. ACROSS formats, choose per (date, category) where category is
 * 'trade' or 'settle': the TIMED source wins when it has at least as many rows of that category on that date
 * as the DATED source (a timed export that starts mid-session — e.g. 2025-06-06 — loses that date).
 * Returns { rows, sourceByDate: { 'YYYY-MM-DD': { trade: 'timed'|'dated', settle: ... } } }.
 */
function combineExports(parsed) {
  const byFormat = { timed: [], dated: [] };
  for (const p of parsed) byFormat[p.format].push(p.rows);
  const dedupe = sets => {
    const best = new Map();
    sets.forEach((rows, fi) => {
      const cnt = new Map();
      for (const r of rows) { const k = rowKey(r); if (!cnt.has(k)) cnt.set(k, []); cnt.get(k).push(r); }
      for (const [k, rs] of cnt) { const prev = best.get(k); if (!prev || rs.length > prev.length) best.set(k, rs.map(r => ({ ...r, file: fi }))); }
    });
    return [...best.values()].flat();
  };
  const timed = dedupe(byFormat.timed), dated = dedupe(byFormat.dated);
  const count = (rows, pred) => { const m = {}; for (const r of rows) if (r.opt && pred(r)) m[r.date] = (m[r.date] || 0) + 1; return m; };
  const tT = count(timed, isTrade), dT = count(dated, isTrade), tS = count(timed, isSettle), dS = count(dated, isSettle);
  const allDates = new Set([...timed, ...dated].map(r => r.date));
  const sourceByDate = {};
  for (const d of allDates) {
    const pick = (t, x) => (t[d] || 0) === 0 && (x[d] || 0) === 0 ? null : ((t[d] || 0) >= (x[d] || 0) ? 'timed' : 'dated');
    sourceByDate[d] = { trade: pick(tT, dT), settle: pick(tS, dS), counts: { timedTrade: tT[d] || 0, datedTrade: dT[d] || 0, timedSettle: tS[d] || 0, datedSettle: dS[d] || 0 } };
  }
  const keep = r => {
    if (!r.opt) return r.format === 'timed' || !timed.length;
    const s = sourceByDate[r.date];
    const cat = isTrade(r) ? 'trade' : isSettle(r) ? 'settle' : null;
    return !cat || s[cat] === r.format;
  };
  return { rows: [...timed.filter(keep), ...dated.filter(keep)], timed, dated, sourceByDate };
}

const TRADE_ACTIONS = { 'Bought To Open': { side: 1, open: true }, 'Sold Short': { side: -1, open: true },
  'Bought To Cover': { side: 1, open: false }, 'Sold To Close': { side: -1, open: false } };

/**
 * Split normalized rows into NDX-option fills and settlement rows.
 *   fills:       trade legs (opens + closes)
 *   settlements: 'Sold' (cash settlement at intrinsic) and 'Option Expired' — RECONCILIATION ONLY
 * `etOffsetHours`: TIMED export clock minus ET (verified +3 for the 2025-06 export; see summary.md).
 */
function extractNdx(rows, { roots = ['NDXP', 'NDX'], etOffsetHours = 3 } = {}) {
  const fills = [], settlements = [], dropped = {};
  const drop = why => { dropped[why] = (dropped[why] || 0) + 1; };
  for (const r of rows) {
    if (!r.opt) { drop(`non-option:${r.type}`); continue; }
    if (!roots.includes(r.opt.root)) { drop(`other-root:${r.opt.root}`); continue; }
    const o = r.opt;
    if (isSettle(r)) {
      settlements.push({ kind: r.type === 'Sold' ? 'cash-settle' : 'expired', format: r.format, postedDate: r.date, postedTime: r.time,
        root: o.root, right: o.right, strike: o.strike, expiry: o.expiry, qty: r.qty,
        qtySigned: r.qtySigned != null ? r.qtySigned : null, price: r.price || 0, amount: r.amount });
      continue;
    }
    const act = TRADE_ACTIONS[r.type];
    if (!act) { drop(`unknown-type:${r.type}`); continue; }
    const etSec = r.timeSec != null ? r.timeSec - etOffsetHours * 3600 : null;
    const gross = -act.side * r.price * 100 * r.qty;
    fills.push({
      format: r.format, seq: r.seq, file: r.file, orderNo: r.orderNo, date: r.date, timeRaw: r.time, etSec,
      timeET: etSec == null ? null : secToHms(etSec),
      action: r.type, open: act.open, side: act.side, root: o.root, right: o.right, strike: o.strike, expiry: o.expiry,
      qty: r.qty, price: r.price, gross: r2(gross), amount: r.amount,
      fees: r2(gross - r.amount),                 // ALL-IN cost (listed Fee+Comm understate it)
      feeListed: r.feeListed, commListed: r.commListed,
    });
  }
  return { fills, settlements, dropped };
}

const gcdI = (a, b) => (b ? gcdI(b, a % b) : Math.abs(a));

function secToHms(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

/**
 * Infer ORDERS for date-only fills (no order #). Every multi-leg spread this trader uses (vertical, fly, ratio
 * fly, condor, iron condor) nets to ZERO contracts per right, and the DATED export lists an order's legs close
 * together (roughly reverse-chronological) but legs of ADJACENT orders interleave. So, per (file, date):
 * take the first unassigned row as an anchor and pick, from the next `window` unassigned rows with the same
 * expiry and open/close effect, the companion set that balances it with the smallest total row distance
 * (then fewer legs, then legs whose prices share the anchor's cents). An anchor that cannot be balanced
 * becomes a single-leg order. Finally, ADJACENT groups with an identical leg structure (same strikes, sides
 * and ratios) are merged as partial fills of one order — the timed export shows the user's orders filling in
 * pieces (e.g. 2 lots as 1+1, seconds apart) at nearly the same net, so the merge also requires the per-unit net
 * to agree within 0.5 pt (a re-entry of the same spread minutes later at a different price stays separate). Validated against true order numbers on the
 * overlap days — see summary.md. Returns an array of arrays of fills (same objects).
 */
function inferOrders(fills, { window = 6, maxExtra = 3 } = {}) {
  const runs = new Map();
  for (const f of fills) {
    const k = `${f.file}|${f.date}`;
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(f);
  }
  const cents = p => Math.round((p * 100) % 100);
  const out = [];
  for (const seq of runs.values()) {
    seq.sort((a, b) => a.seq - b.seq);
    const used = new Array(seq.length).fill(false);
    for (let i = 0; i < seq.length; i++) {
      if (used[i]) continue;
      const a = seq[i];
      const cand = [];
      for (let j = i + 1; j < seq.length && cand.length < window; j++) {
        if (used[j]) continue;
        if (seq[j].expiry === a.expiry && seq[j].open === a.open) cand.push(j);
      }
      let best = null;
      const consider = idx => {
        const net = { C: 0, P: 0 };
        for (const k of [i, ...idx]) net[seq[k].right] += seq[k].side * seq[k].qty;
        if (net.C !== 0 || net.P !== 0) return;
        const score = idx.reduce((s, k) => s + (k - i), 0)          // nearness first: legs are listed together
          + idx.length                                                // then fewer legs
          - idx.filter(k => cents(seq[k].price) === cents(a.price)).length * 0.5;
        if (!best || score < best.score) best = { idx, score };
      };
      const rec = (start, chosen) => {
        if (chosen.length) consider(chosen);
        if (chosen.length >= maxExtra) return;
        for (let c = start; c < cand.length; c++) rec(c + 1, [...chosen, cand[c]]);
      };
      rec(0, []);
      const group = [i, ...(best ? best.idx : [])];
      group.forEach(k => { used[k] = true; });
      out.push(group.sort((x, y) => x - y).map(k => seq[k]));
    }
  }
  // merge adjacent partial fills of the same structure
  const shape = g => {
    const u = g.reduce((m, f) => { const k = `${f.right}${f.strike}${f.side}`; m[k] = (m[k] || 0) + f.qty; return m; }, {});
    const q = Object.values(u).reduce((a, b) => gcdI(a, b), 0);
    return `${g[0].date}|${g[0].expiry}|` + Object.entries(u).sort().map(([k, v]) => `${k}x${v / q}`).join(',');
  };
  const netPer = g => {           // net premium per unit (points) — partial fills of one order fill near the same net
    const q = g.reduce((a, f) => gcdI(a, f.qty), 0);
    return g.reduce((s, f) => s + f.side * f.qty * f.price, 0) / q;
  };
  const merged = [];
  for (const g of out) {
    const prev = merged[merged.length - 1];
    if (prev && g.length > 1 && shape(prev) === shape(g) && Math.abs(netPer(prev) - netPer(g)) <= 0.5) prev.push(...g);
    else merged.push([...g]);
  }
  return merged;
}

/**
 * Score inferOrders against TRUE orders on days both exports cover. `timedFills` carry real order numbers,
 * `datedFills` are the same executions without them. An inferred group counts as a hit when its legs
 * (right, strike, side, price, qty — aggregated) equal one true order's legs exactly.
 */
function validateInference(timedFills, datedFills, dates, opts) {
  const sig = legs => {
    const m = {};
    for (const f of legs) { const k = `${f.right}${f.strike}${f.side > 0 ? '+' : '-'}@${f.price}`; m[k] = (m[k] || 0) + f.qty; }
    return Object.entries(m).sort().map(x => x.join('x')).join(' ');
  };
  const perDay = {};
  let orders = 0, hits = 0, fills = 0, fillsInHits = 0;
  for (const d of dates) {
    const truthOrders = {};
    for (const f of timedFills.filter(x => x.date === d)) (truthOrders[f.orderNo] = truthOrders[f.orderNo] || []).push(f);
    const truth = new Map();
    for (const l of Object.values(truthOrders)) { const k = sig(l); truth.set(k, (truth.get(k) || 0) + 1); }
    const inferred = inferOrders(datedFills.filter(x => x.date === d), opts);
    let h = 0, fh = 0;
    for (const g of inferred) { const k = sig(g); if (truth.get(k) > 0) { truth.set(k, truth.get(k) - 1); h++; fh += g.length; } }
    const n = Object.keys(truthOrders).length, nf = datedFills.filter(x => x.date === d).length;
    perDay[d] = { trueOrders: n, inferredOrders: inferred.length, exactMatches: h, fills: nf, fillsInExactMatches: fh };
    orders += n; hits += h; fills += nf; fillsInHits += fh;
  }
  return { perDay, trueOrders: orders, exactMatches: hits, orderMatchRate: orders ? hits / orders : null, fills, fillsInExactMatches: fillsInHits, fillMatchRate: fills ? fillsInHits / fills : null };
}

module.exports = { validateInference,  splitCsvLine, parseStamp, parseOptionDescription, parseDatedDescription, parseExport, combineExports, extractNdx, inferOrders, secToHms, money };
