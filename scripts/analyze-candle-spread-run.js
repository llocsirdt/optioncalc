#!/usr/bin/env node
/**
 * Render a candle-spread run log as a readable timeline table, or compare the 3 shadow
 * variants (v0 fixed / v1 greedy / v2 joint) side by side.
 *
 * Usage:
 *   node scripts/analyze-candle-spread-run.js <SYMBOL> <EXPIRATION> [YYYY-MM-DD] [flags]
 * Flags:
 *   --local            hit localhost:3001 instead of the deployed server
 *   --variant v0|v1|v2 render a specific variant's timeline
 *   --compare          fetch v0/v1/v2 and compare them (summary + cumulative P/L by candle)
 *   --offline          skip the server; read the last-cached copy from candle-spread-archive/
 *
 * Every successful fetch is cached to candle-spread-archive/<runId>.json on THIS machine, and
 * fetches fall back to that cache when the server no longer has the run — so a server restart
 * or deploy can't cost us the history we've already looked at (until S3 backup is wired).
 *
 * Examples:
 *   node scripts/analyze-candle-spread-run.js NDX 2026-08-19 --variant v1
 *   node scripts/analyze-candle-spread-run.js NDX 2026-08-19 --compare
 */
const fs = require('fs');
const path = require('path');
const PROD = 'https://d1kbxyxn33vpw2.cloudfront.net';
const LOCAL = 'http://localhost:3001';
const ARCHIVE = path.join(__dirname, '..', 'candle-spread-archive');

const args = process.argv.slice(2);
const local = args.includes('--local');
const compare = args.includes('--compare');
const offline = args.includes('--offline');
const vIdx = args.indexOf('--variant');
const variant = vIdx >= 0 ? args[vIdx + 1] : null;
const rest = args.filter((a, i) => !a.startsWith('--') && !(vIdx >= 0 && i === vIdx + 1));
const [symbol, expiration, dateArg] = rest;
if (!symbol || !expiration) {
  console.error('Usage: node scripts/analyze-candle-spread-run.js <SYMBOL> <EXPIRATION> [YYYY-MM-DD] [--local] [--variant vN] [--compare] [--offline]');
  process.exit(1);
}
const date = dateArg || expiration; // 0DTE: tradeDate == expiration
const base = local ? LOCAL : PROD;

const runId = v => `${symbol}_${expiration}_${date}${v ? `_${v}` : ''}`;
const archivePath = v => path.join(ARCHIVE, `${runId(v)}.json`);
function saveArchive(v, j) {
  try { fs.mkdirSync(ARCHIVE, { recursive: true }); fs.writeFileSync(archivePath(v), JSON.stringify(j, null, 2)); } catch (_) { /* best-effort */ }
}
function loadArchive(v) {
  try { return JSON.parse(fs.readFileSync(archivePath(v), 'utf8')); } catch (_) { return null; }
}

const runUrl = v => `${base}/api/v1/candle-spread/runs/${symbol}/${expiration}?date=${date}${v ? `&variant=${v}` : ''}`;
async function fetchRun(v) {
  if (offline) return loadArchive(v);
  try {
    const res = await fetch(runUrl(v));
    const j = await res.json();
    if (j && !j.error) { saveArchive(v, j); return j; }        // cache the freshest copy
  } catch (_) { /* network error -> fall through to cache */ }
  return loadArchive(v);                                        // server lost it? use our local copy
}

const money = n => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
// "08/17 11:30" is the candle OPEN; it closed 15 min later.
const closeTime = lbl => {
  const hm = (lbl || '').split(' ')[1] || '';
  let [h, m] = hm.split(':').map(Number);
  m += 15; if (m >= 60) { m -= 60; h++; }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
// e.g. bear-put +P30140/-P30120
const spreadStr = legs => {
  const type = legs[0].type === 'C' ? 'call' : 'put';
  const l = legs.map(x => `${x.side === 'long' ? '+' : '-'}${x.type}${x.strike}`).join('/');
  return `${type.padEnd(4)} ${l}`;
};
const pad = (s, n) => String(s).padEnd(n);
const candleCloses = j => (j.events || []).filter(e => e.type === 'candle_close');

// --- single-run timeline --------------------------------------------------
function renderTimeline(j) {
  const cc = candleCloses(j);
  const v = j.config.variant ? ` [${j.config.variant}/${j.config.coverSelector}]` : '';
  const sig = j.config.signalSymbol && j.config.signalSymbol !== j.config.symbol ? `  signal=${j.config.signalSymbol}` : '';
  console.log(`RUN  ${j.config.symbol} ${j.config.expiration} (0DTE)${v}${sig}  |  width $${j.config.spreadWidth}, incr ${j.config.strikeIncrement}, qty ${j.config.quantity}, cover=${j.config.coverStyle}/${j.config.coverTiming}, dryRun=${j.config.dryRun}`);
  if (!cc.length) { console.log('(no candle_close events yet)'); return; }
  console.log(`first action ~${closeTime(cc[0].candle.time)} ET · last ~${closeTime(cc[cc.length - 1].candle.time)} ET · ${cc.length} candles\n`);

  console.log(`${pad('TIME', 6)}${pad('CLOSE', 9)}${pad('CAND', 6)}${pad('ACTION', 7)}${pad('SPREAD (strikes)', 22)}${pad('GEO', 6)}${pad('LIMIT', 8)}${pad('LOCK', 8)}${pad('DIR', 6)}RUN P/L`);
  console.log('-'.repeat(92));

  for (const e of cc) {
    const t = closeTime(e.candle.time);
    // CLOSE column shows the PRICING underlying (NDX) so it aligns with the strikes; when
    // signal==price they're the same. (The signal candle's own close can differ by the basis.)
    const close = Number(e.underlying != null ? e.underlying : e.candle.close).toFixed(0);
    const col = e.classification.simpleDir === 'bull' ? 'green' : e.classification.simpleDir === 'bear' ? 'red' : 'flat';
    const rows = [];
    for (const d of e.decisions) {
      if (d.action === 'open') rows.push(['OPEN', spreadStr(d.legs), '', `$${d.limit}`, '']);
      else if (d.action === 'cover') rows.push(['COVER', spreadStr(d.legs), d.geometry || '', `$${d.limit}`, money(d.lockedFloor)]);
      else if (d.action === 'cancel-open') rows.push(['CANCEL', 'unfilled open', '', '', '']);
      else if (d.action === 'open-skip-conflict') rows.push(['HOLD', `counter-signal (${d.side}), trend intact`, '', '', '']);
      else if (d.action === 'open-skip') rows.push(['SKIP', `open ${d.side}: ${d.error || ''}`, '', '', '']);
      else if (d.action === 'neutral') rows.push(['—', 'no trade (neutral)', '', '', '']);
      else rows.push([d.action, '', '', '', '']);
    }
    let why = '';
    const cx = e.coverContext;
    if (cx) {
      const opposite = (cx.heldDirection === 'bull' && cx.reversalDir === 'bear') || (cx.heldDirection === 'bear' && cx.reversalDir === 'bull');
      if (cx.covered) why = cx.bbOverride ? '  ← cover: BB override' : (cx.heldDirection === 'bull' ? '  ← cover: no new high' : '  ← cover: no new low');
      else if (opposite) why = cx.heldDirection === 'bull' ? '  ← HELD: broke prior high' : '  ← HELD: broke prior low';
    }
    rows.forEach((r, i) => {
      const [head, close2, cand2] = i === 0 ? [t, close, col] : ['', '', ''];
      const last = i === rows.length - 1;
      const dir = last ? e.direction : '';
      const pl = last ? money(e.realizedPnl) : '';
      console.log(`${pad(head, 6)}${pad(close2, 9)}${pad(cand2, 6)}${pad(r[0], 7)}${pad(r[1], 22)}${pad(r[2], 6)}${pad(r[3], 8)}${pad(r[4], 8)}${pad(dir, 6)}${pad(pl, 8)}${last ? why : ''}`);
    });
  }

  const opens = cc.reduce((n, e) => n + e.decisions.filter(d => d.action === 'open').length, 0);
  const covers = cc.reduce((n, e) => n + e.decisions.filter(d => d.action === 'cover').length, 0);
  const openPos = (j.state.positions || []).filter(p => p.filled && !p.covered);
  console.log('-'.repeat(92));
  console.log(`SUMMARY  ${opens} opens · ${covers} covers · final dir: ${j.state.direction} · locked/floor P/L: ${money(j.state.realizedPnl)}`);
  console.log(`still open (uncovered): ${openPos.length}${openPos.length ? ' -> ' + openPos.map(p => spreadStr(p.legs)).join(', ') : ''}`);
  const eod = (j.events || []).find(e => e.type === 'eod_settlement');
  if (eod && eod.terminalPnl != null) {
    console.log(`TERMINAL P/L @ settle ${eod.settle}: ${money(eod.terminalPnl)}  (guaranteed floor was ${money(eod.floorPnl)})`);
  }
}

// --- 3-variant comparison -------------------------------------------------
function variantStats(j) {
  const cc = candleCloses(j);
  const geo = {};
  let opens = 0, covers = 0;
  for (const e of cc) for (const d of e.decisions) {
    if (d.action === 'open') opens++;
    if (d.action === 'cover') { covers++; geo[d.geometry || '?'] = (geo[d.geometry || '?'] || 0) + 1; }
  }
  const byTime = {};
  for (const e of cc) byTime[closeTime(e.candle.time)] = e.realizedPnl;
  const eod = (j.events || []).find(e => e.type === 'eod_settlement');
  return {
    label: `${j.config.variant || '—'}/${j.config.coverSelector || j.config.coverStyle}`,
    opens, covers, geo, byTime,
    realized: j.state.realizedPnl,
    terminal: eod && eod.terminalPnl != null ? eod.terminalPnl : null,
    settle: eod ? eod.settle : null,
    open: (j.state.positions || []).filter(p => p.filled && !p.covered).length
  };
}

function renderCompare(runs) {
  const present = runs.filter(Boolean);
  if (!present.length) { console.log('No variant runs found for', symbol, expiration, date, '\n(are the 3-variant runs deployed and has a session occurred?)'); return; }
  // De-dupe by runId: an OLD server ignores ?variant= and returns the same pre-variant run
  // three times. Only treat this as a comparison when the runIds actually differ.
  const uniq = [];
  const seen = new Set();
  for (const j of present) { if (!seen.has(j.runId)) { seen.add(j.runId); uniq.push(j); } }
  if (uniq.length <= 1) {
    console.log(`Only one run found for ${symbol} ${expiration} ${date} — variant runs not deployed yet, or no session this day. Showing it:\n`);
    if (uniq.length === 1) renderTimeline(uniq[0]);
    return;
  }
  const stats = uniq.map(variantStats);
  const times = [...new Set(uniq.flatMap(j => candleCloses(j).map(e => closeTime(e.candle.time))))].sort();

  const settle = stats.map(s => s.settle).find(x => x != null);
  console.log(`COMPARE  ${symbol} ${expiration} (0DTE)  |  ${stats.length} variant(s)${settle != null ? `  · settle ${settle}` : ''}\n`);
  console.log(`${pad('VARIANT', 14)}${pad('OPENS', 7)}${pad('COVERS', 8)}${pad('FLOOR', 9)}${pad('TERMINAL', 10)}${pad('OPEN', 6)}GEOMETRY`);
  console.log('-'.repeat(80));
  for (const s of stats) {
    const geo = Object.entries(s.geo).map(([k, n]) => `${k}:${n}`).join(' ') || '—';
    const term = s.terminal != null ? money(s.terminal) : '—';
    console.log(`${pad(s.label, 14)}${pad(s.opens, 7)}${pad(s.covers, 8)}${pad(money(s.realized), 9)}${pad(term, 10)}${pad(s.open, 6)}${geo}`);
  }

  // Cumulative P/L by candle so divergence is visible.
  console.log(`\nCUMULATIVE P/L BY CANDLE`);
  console.log(`${pad('TIME', 7)}${stats.map(s => pad(s.label, 12)).join('')}`);
  console.log('-'.repeat(7 + stats.length * 12));
  let last = stats.map(() => 0);
  for (const t of times) {
    const cells = stats.map((s, i) => {
      if (s.byTime[t] != null) last[i] = s.byTime[t];
      return pad(money(last[i]), 12);
    });
    console.log(`${pad(t, 7)}${cells.join('')}`);
  }
  // Rank by TERMINAL settlement P/L when available (the fair metric), else the floor.
  const metric = s => (s.terminal != null ? s.terminal : s.realized);
  const best = stats.slice().sort((a, b) => metric(b) - metric(a))[0];
  console.log('-'.repeat(7 + stats.length * 12));
  const basis = best.terminal != null ? 'terminal settlement' : 'floor (no settle yet)';
  console.log(`BEST by ${basis}: ${best.label} at ${money(metric(best))}`);
}

(async () => {
  if (compare) {
    const runs = await Promise.all(['v0', 'v3', 'v1', 'v2'].map(fetchRun));
    return renderCompare(runs);
  }
  const j = await fetchRun(variant);
  if (!j) { console.error('run not found / error\nurl:', runUrl(variant)); process.exit(1); }
  renderTimeline(j);
})();
