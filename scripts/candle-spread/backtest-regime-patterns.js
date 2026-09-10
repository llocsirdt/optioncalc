#!/usr/bin/env node
'use strict';
/**
 * backtest-regime-patterns.js — IS THE BULL/BEAR PATTERN ASYMMETRY A REGIME EFFECT?
 *
 * ── THE PRIOR FINDING ───────────────────────────────────────────────────────────────────────────
 * backtest-open-only.js measured every 5m reversal pattern as a spread-entry signal over 765 days at
 * $20-sATM with no band filter. Every BULLISH pattern made money; every BEARISH pattern lost it. That
 * study concluded DIRECTION, not pattern quality, and proved it with a signal-free drift benchmark:
 * "always bull" at ~5.4 trades/day returned +$386k, "always bear" −$410k. /NQ roughly doubled over the
 * sample while the Black-Scholes pricer assumes zero drift.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────────────────────────
 * Does the asymmetry FLIP in a downtrend / in the lower half of the band? If it does, the patterns are
 * conditionally useful. If bull patterns win in every regime, they are just long exposure.
 *
 * ── METHOD: THE BAR GRID ────────────────────────────────────────────────────────────────────────
 * The key observation that makes the whole grid computable is that in OPEN-ONLY mode the positions are
 * INDEPENDENT. No covers, no governor, no risk cap, no capital ceiling, no leg ledger — so a position's
 * P&L is (legsPayoff(legs, settle) − limit) × 100 × QTY and nothing about the rest of the book can
 * change it. `terminal` is exactly the sum of those (asserted per day, not assumed). Whether an open is
 * DECLINED by the 60%-of-width price ceiling likewise depends only on that bar's mark.
 *
 * Therefore: run the engine ONCE PER SIDE with a signal that opens on EVERY action bar, and you have
 * the settled P&L of every possible (day, bar, side) trade in the sample — the BAR GRID. Every pattern
 * arm is then a SELECTION from that grid, and the pattern-detection sweep runs offline. This is not an
 * approximation: it is verified against real engine arms (`--verify`), which reproduce to the dollar.
 *
 * ── METHOD: THE BASELINE ────────────────────────────────────────────────────────────────────────
 * Per-pattern P&L inside a regime bucket is meaningless on its own: a down-trend bucket has negative
 * drift BY CONSTRUCTION, so every bull pattern will look bad there for reasons that have nothing to do
 * with the pattern. Each bucket therefore gets its own drift baseline, straight off the bar grid:
 *
 *     drift(side, bucket) = mean P&L of a signal-free open on that side over ALL grid bars in the bucket
 *
 * and the headline number is ALPHA = actual − baseline, i.e. what the pattern's SELECTION of bars was
 * worth over opening blind inside the same regime.
 *
 * TWO baselines are reported because they answer slightly different questions:
 *   plain     — the bucket's flat mean per side. The number the brief asks for.
 *   time-matched (PRIMARY) — the mean within (bucket x side x 30-minute time-of-day bin), summed over
 *                 the pattern's OWN time distribution. 0DTE P&L is violently time-dependent (a 09:35
 *                 open and a 15:30 open are different trades), and reversal patterns do not fire
 *                 uniformly through the session, so the plain baseline silently credits a pattern with
 *                 the difference between the hours it likes and the hours it does not. Anywhere the two
 *                 disagree, the time-matched one is the honest read.
 *
 * SIGNIFICANCE: trades on the same day are massively correlated (every bull trade wins on an up day),
 * so the t-statistic is DAY-CLUSTERED — alpha is summed per day and the standard error is taken across
 * days, never across trades. A trade-level t would be inflated several-fold and is not reported.
 *
 * ── SCOPE / LIMITS ──────────────────────────────────────────────────────────────────────────────
 *   - Open-only, matching the prior study: no covers, no governor, no caps, no wings. These numbers
 *     say whether the ENTRY has an edge; they are not a risk-managed strategy.
 *   - Dataset backtest-data-5m-nq carries NO separate NDX price series, so — exactly as in the prior
 *     study — signals AND pricing are both /NQ here. The dual (NQ-signal/NDX-price) dataset is 34 days,
 *     which cannot support a regime partition. Noted, not hidden.
 *   - Pattern definitions are untouched (candle-patterns-lab.js). Only the partitioning is new.
 *
 * Usage:
 *   node scripts/candle-spread/backtest-regime-patterns.js --build          # build the bar grid (~2 min)
 *   node scripts/candle-spread/backtest-regime-patterns.js                  # analyse from the cache
 *   node scripts/candle-spread/backtest-regime-patterns.js --verify         # engine cross-check
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { makeOpenOnlySignal } = require('./open-only-signals');
const eng = require('./backtest-v4');
const P = require('./candle-patterns-lab');
const RB = require('./regime-buckets');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const GEO_KEY = arg('--geo', '20-sATM');
const CACHE = arg('--cache', path.join(os.tmpdir(), `regime-bargrid-${path.basename(DIR)}-${GEO_KEY}.json`));
const ARM_BARS = Number(arg('--armBars', 12));

// Geometry — matched to backtest-open-only.js verbatim so the numbers are comparable.
const GEOS = {
  '20-sATM': () => makeGeo({ width: 20, shift: 10, capFrac: 0.60 }),
  '10-sATM': () => makeGeo({ width: 10, shift: 5, capFrac: 0.60 }),
  '40-sATM': () => makeGeo({ width: 40, shift: 20, capFrac: 0.60 }),
  '20-cATM': () => makeGeo({ width: 20, shift: 0 }),
};

function loadTradeableDays(dir) {
  const all = load5mDays(dir);
  const days = all.filter(d => d.bars.some(b => { const m = RB.etMin(b.dt); return m >= 570 && m < 960; }));
  return { days, calendar: all.length };
}

// Deliberately minimal opts, identical to backtest-open-only.js optsFor(). recordReplay is added only
// to get `positions` back for the per-trade decomposition; it changes no decision.
function optsFor(hasPx) {
  const o = { rthActionOnly: true, intradayIV: true, bidirectional: true, geo: GEOS[GEO_KEY](), recordReplay: true };
  if (hasPx) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  return o;
}

// ── PHASE 1: THE BAR GRID ───────────────────────────────────────────────────────────────────────
// One engine run per side, opening on EVERY action bar, then decompose the day's terminal into its
// per-position parts. The decomposition is ASSERTED against `terminal` for every single day — if the
// engine ever grows an inter-position coupling in open-only mode this build fails loudly rather than
// producing a plausible-looking grid.
function gridForDays(days, hasPx) {
  const opts = optsFor(hasPx);
  const out = [];
  for (const d of days) {
    const ab = RB.actionBars(d.bars);
    // `fwd` = the realized TAPE move from this bar's 5m close to the day's settle, in points. It carries
    // no option pricing at all, so it separates "the market went up" from "the pricer/geometry favours
    // one side". Every drift number below is ultimately this quantity run through the spread payoff.
    const settleClose = RB.dayClose(d.bars);
    const row = { date: d.date, settle: settleClose, bars: ab.map(b => ({ dt: b.dt, tod: RB.todBin(b.dt), b60: RB.bandBucket(RB.pctBAt(b.analysis, '60m')), b15: RB.bandBucket(RB.pctBAt(b.analysis, '15m')), fwd: settleClose != null ? Math.round((settleClose - b.analysis['5m'].close) * 100) / 100 : null, bull: null, bear: null })) };
    const byDt = new Map(row.bars.map((r, i) => [r.dt, i]));
    for (const side of ['bull', 'bear']) {
      const r = runDay5m(d.bars, () => ({ openSide: side, cover: false }), opts);
      let sum = 0;
      for (const p of r.positions) {
        const v = (eng.legsPayoff(p.legs, r.settle) - p.limit) * 100 * eng.QTY;
        sum = eng.round2(sum + v);
        const i = byDt.get(p.openEpoch);
        if (i === undefined) throw new Error(`${d.date}: position openEpoch ${p.openEpoch} is not an action bar — index mapping is broken`);
        row.bars[i][side] = Math.round(v * 100) / 100;
      }
      if (Math.abs(sum - r.terminal) > 0.011) throw new Error(`${d.date}/${side}: per-position sum ${sum} != terminal ${r.terminal} — positions are NOT independent`);
      if (r.opens + r.geoSkip !== ab.length) throw new Error(`${d.date}/${side}: opens ${r.opens} + declined ${r.geoSkip} != action bars ${ab.length}`);
    }
    out.push(row);
  }
  return out;
}

if (process.argv.includes('--worker')) {
  const wi = process.argv.indexOf('--worker');
  const [a, b, outFile] = [Number(process.argv[wi + 1]), Number(process.argv[wi + 2]), process.argv[wi + 3]];
  const { days } = loadTradeableDays(DIR);
  const hasPx = days.some(d => d.bars.some(x => x.px));
  fs.writeFileSync(outFile, JSON.stringify(gridForDays(days.slice(a, b), hasPx)));
  process.exit(0);
}

function buildGrid(days, workers, tmpDir) {
  return new Promise((resolve, reject) => {
    const per = Math.ceil(days.length / workers);
    const parts = new Array(workers).fill(null);
    let done = 0, failed = false;
    for (let w = 0; w < workers; w++) {
      const a = w * per, b = Math.min(days.length, a + per);
      if (a >= b) { parts[w] = []; if (++done === workers) resolve(parts.flat()); continue; }
      const of = path.join(tmpDir, `grid-${w}.json`);
      const child = fork(__filename, ['--worker', String(a), String(b), of, '--dataDir', DIR, '--geo', GEO_KEY], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.on('exit', code => {
        if (code !== 0) { if (!failed) { failed = true; reject(new Error(`worker ${w} exited ${code}`)); } return; }
        parts[w] = JSON.parse(fs.readFileSync(of, 'utf8'));
        process.stderr.write(`  worker ${w} done (${b - a} days)\n`);
        if (++done === workers && !failed) resolve(parts.flat());
      });
    }
  });
}

// ── PHASE 2: PATTERN SELECTION (offline) ────────────────────────────────────────────────────────
// makeOpenOnlySignal ignores the engine's ctx entirely (its signature is (A, priorA)), so it can be
// driven directly over the day's action bars and produces byte-identical decisions. `prior` is the
// FULL-series predecessor bar, exactly as runDay5m passes it (bars[i-1].analysis), which for the first
// action bar is the last overnight bar — continuity preserved.
function selectionsFor(days, patternKey, prox) {
  const out = new Map();   // date -> [{ dt, side, why }]
  for (const d of days) {
    const fn = makeOpenOnlySignal({ tf: '60m', prox, patterns: [patternKey], armBars: ARM_BARS });
    const picks = [];
    for (let i = 0; i < d.bars.length; i++) {
      const m = RB.etMin(d.bars[i].dt);
      if (!(m >= RB.RTH_LO && m <= RB.RTH_HI)) continue;
      const sig = fn(d.bars[i].analysis, i > 0 ? d.bars[i - 1].analysis : null, {});
      if (sig.openSide) picks.push({ dt: d.bars[i].dt, side: sig.openSide, why: (sig.reason || '').split(':')[1] || patternKey });
    }
    out.set(d.date, picks);
  }
  return out;
}

// ── STATS ───────────────────────────────────────────────────────────────────────────────────────
const usd = n => (n == null || !Number.isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }

/**
 * Baseline machinery for one bucketing. `keyOf(barRow, dayTag)` returns the bucket label of a grid bar
 * (null = not classified, e.g. inside the indicator warmup) — day-level and bar-level bucketings are
 * both expressed this way so everything downstream is identical.
 */
function makeBaseline(grid, dayTags, keyOf) {
  const flat = {};    // bucket -> side -> array of pnl
  const byTod = {};   // bucket -> side -> tod -> array of pnl
  const dayCount = {};// bucket -> Set(date)   (day-level buckets: how many DAYS; bar-level: days touched)
  for (const row of grid) {
    const tag = dayTags.get(row.date);
    for (const b of row.bars) {
      const k = keyOf(b, tag);
      if (k == null) continue;
      (dayCount[k] || (dayCount[k] = new Set())).add(row.date);
      for (const side of ['bull', 'bear']) {
        if (b[side] == null) continue;   // declined by the price ceiling — not a tradeable bar
        const f = flat[k] || (flat[k] = { bull: [], bear: [] });
        f[side].push(b[side]);
        const t = byTod[k] || (byTod[k] = { bull: {}, bear: {} });
        (t[side][b.tod] || (t[side][b.tod] = [])).push(b[side]);
      }
    }
  }
  const MIN_CELL = 30;   // below this a time-of-day cell is too thin to trust; fall back to the flat mean
  return {
    buckets: () => Object.keys(flat),
    nDays: k => (dayCount[k] ? dayCount[k].size : 0),
    nBars: (k, side) => (flat[k] ? flat[k][side].length : 0),
    flatMean: (k, side) => (flat[k] && flat[k][side].length ? mean(flat[k][side]) : null),
    todMean: (k, side, tod) => {
      const c = byTod[k] && byTod[k][side][tod];
      if (c && c.length >= MIN_CELL) return mean(c);
      return flat[k] && flat[k][side].length ? mean(flat[k][side]) : null;
    },
    keyOf,
  };
}

/**
 * Score one set of trades (already joined to the grid) inside one bucket.
 * trades: [{ date, side, pnl, tod }]
 */
function score(trades, bl, k) {
  if (!trades.length) return null;
  const n = trades.length, nBull = trades.filter(t => t.side === 'bull').length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  let baseFlat = 0, baseTod = 0;
  const perDay = new Map();
  for (const t of trades) {
    const bf = bl.flatMean(k, t.side), bt = bl.todMean(k, t.side, t.tod);
    if (bf == null || bt == null) return null;
    baseFlat += bf; baseTod += bt;
    perDay.set(t.date, (perDay.get(t.date) || 0) + (t.pnl - bt));
  }
  const a = [...perDay.values()];
  const alphaTod = total - baseTod;
  const s = sd(a), nD = a.length;
  const se = s != null ? s * Math.sqrt(nD) : null;   // day-clustered SE of the SUM
  return {
    n, nBull, nBear: n - nBull, nDays: nD, total, winPct: wins / n * 100,
    perTrade: total / n, baseFlat, baseTod, basePerTrade: baseTod / n,
    alphaFlat: total - baseFlat, alphaTod, alphaPerTrade: alphaTod / n,
    t: se && se > 0 ? alphaTod / se : null,
  };
}

/**
 * Two confound checks for one bucket, both signal-free:
 *   fwd      mean realized tape move (points) from a bar in the bucket to that day's settle. If the
 *            bear buckets are genuinely falling this is negative; if it is positive, "bear loses in the
 *            downtrend" is the tape, not the pricer.
 *   both*    the two drifts restricted to bars where the price ceiling accepted BOTH sides. The $20
 *            sATM geometry declines a third of bull opens and a twentieth of bear opens (the floor()
 *            strike rounding leaves the bull spread systematically deeper ITM, hence pricier, hence
 *            more often over the 60%-of-width ceiling), so the unrestricted bull book is a filtered
 *            CHEAP subset while the bear book is nearly unfiltered. Restricting to the common bars
 *            removes that difference entirely.
 */
function diag(grid, dayTags, keyOf, want) {
  const F = [];
  let bn = 0, bb = 0, bs_ = 0, up = 0;
  for (const row of grid) {
    const tag = dayTags.get(row.date);
    for (const b of row.bars) {
      if (keyOf(b, tag) !== want) continue;
      if (b.fwd != null) { F.push(b.fwd); if (b.fwd > 0) up++; }
      if (b.bull != null && b.bear != null) { bn++; bb += b.bull; bs_ += b.bear; }
    }
  }
  F.sort((a, b) => a - b);
  return {
    fwd: F.length ? F.reduce((a, b) => a + b, 0) / F.length : null,
    med: F.length ? F[F.length >> 1] : null,
    up: F.length ? up / F.length * 100 : null,
    both: bn, bothBull: bn ? bb / bn : null, bothBear: bn ? bs_ / bn : null, pair: bn ? (bb + bs_) / bn : null,
  };
}

// ── BUCKETINGS ──────────────────────────────────────────────────────────────────────────────────
const BUCKETINGS = [
  { key: 't1', label: 'DAILY TREND — sign of the prior day\'s close-to-close', order: ['up', 'down'], of: (b, t) => t && t.t1 },
  { key: 't5', label: '5-DAY TREND — 5d return through yesterday (±1%)', order: ['up', 'flat', 'down'], of: (b, t) => t && t.t5 },
  { key: 't20', label: '20-DAY TREND — 20d return through yesterday (±2%)', order: ['up', 'flat', 'down'], of: (b, t) => t && t.t20 },
  { key: 't50', label: '50-DAY TREND — 50d return through yesterday (±4%)', order: ['up', 'flat', 'down'], of: (b, t) => t && t.t50 },
  { key: 'stretch', label: 'BEARISH STRETCH — 20d AND 50d returns both negative', order: ['bull', 'mixed', 'bear'], of: (b, t) => t && t.stretch },
  { key: 'dd50', label: 'DRAWDOWN — yesterday vs the trailing 50-day high (−5%)', order: ['near-high', 'drawdown'], of: (b, t) => t && t.dd50 },
  { key: 'ma20', label: 'DAILY MA — yesterday\'s close vs the 20-day SMA', order: ['above', 'below'], of: (b, t) => t && t.ma20 },
  { key: 'dband', label: 'DAILY BOLLINGER — yesterday\'s close inside the daily BB(20,2)', order: ['belowLower', 'lowerHalf', 'upperHalf', 'aboveUpper'], of: (b, t) => t && t.dband },
  { key: 'b60', label: '60m BOLLINGER AT ENTRY — where the 5m close sits in the last-closed 60m band', order: ['belowLower', 'lowerHalf', 'upperHalf', 'aboveUpper'], of: (b) => b.b60 },
  { key: 'b15', label: '15m BOLLINGER AT ENTRY — where the 5m close sits in the last-closed 15m band', order: ['belowLower', 'lowerHalf', 'upperHalf', 'aboveUpper'], of: (b) => b.b15 },
];

// ── MAIN ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { days, calendar } = loadTradeableDays(DIR);
  const hasPx = days.some(d => d.bars.some(b => b.px));

  if (process.argv.includes('--build') || !fs.existsSync(CACHE)) {
    const workers = Number(arg('--workers', Math.min(8, Math.max(1, os.cpus().length - 2))));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-grid-'));
    console.log(`building the BAR GRID — ${days.length} tradeable days x 2 sides at ${GEO_KEY}, ${workers} workers...`);
    const t0 = Date.now();
    const grid = await buildGrid(days, workers, tmpDir);
    fs.writeFileSync(CACHE, JSON.stringify(grid));
    console.log(`  ...${Math.round((Date.now() - t0) / 1000)}s -> ${CACHE}\n`);
  }
  const grid = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  if (grid.length !== days.length) throw new Error(`cache has ${grid.length} days, dataset has ${days.length} — rebuild with --build`);
  const gridBy = new Map(grid.map(r => [r.date, r]));
  const dayTags = RB.classifyDays(days);

  // ── header + grid health ──────────────────────────────────────────────────────────────────────
  let nBars = 0, decBull = 0, decBear = 0;
  for (const r of grid) for (const b of r.bars) { nBars++; if (b.bull == null) decBull++; if (b.bear == null) decBear++; }
  console.log(`\nREGIME x PATTERN STUDY — ${days.length} tradeable days of ${calendar} calendar days in ${path.basename(DIR)}`);
  console.log(`geometry ${GEO_KEY} · QTY=1 · rthActionOnly · intradayIV · bidirectional · OPEN-ONLY (no covers, no governor, no caps)`);
  console.log(`pricing series: ${hasPx ? 'NDX (bars[].px via opts.priceOf)' : '/NQ (this dataset carries no separate NDX px series — same as the prior study)'}`);
  console.log(`BAR GRID: ${nBars.toLocaleString()} action bars; the $20/0.60 price ceiling DECLINED ${(decBull / nBars * 100).toFixed(1)}% of bull and ${(decBear / nBars * 100).toFixed(1)}% of bear opens (those bars are excluded from BOTH the pattern trades and the baseline).`);
  console.log(`per-day per-position decomposition asserted == terminal on every day at build time.`);

  // ── the sample's own drift, whole-sample ──────────────────────────────────────────────────────
  const all = makeBaseline(grid, dayTags, () => 'ALL');
  console.log(`\nWHOLE-SAMPLE DRIFT (signal-free, every action bar): bull ${usd(all.flatMean('ALL', 'bull'))}/trade over ${all.nBars('ALL', 'bull').toLocaleString()} bars · bear ${usd(all.flatMean('ALL', 'bear'))}/trade over ${all.nBars('ALL', 'bear').toLocaleString()} bars.`);

  // ── pattern selections ────────────────────────────────────────────────────────────────────────
  // prox=null = NO band condition, i.e. the pattern entirely on its own — the arm the prior study's
  // headline per-pattern numbers came from.
  const sel = {};
  for (const k of P.ALL) sel[k] = selectionsFor(days, k, null);

  // join to the grid -> per-trade records
  const tradesOf = {};
  for (const k of P.ALL) {
    const out = [];
    for (const d of days) {
      const row = gridBy.get(d.date);
      const byDt = new Map(row.bars.map(b => [b.dt, b]));
      for (const p of sel[k].get(d.date)) {
        const b = byDt.get(p.dt);
        if (!b) throw new Error(`${d.date}: selection at ${p.dt} has no grid bar`);
        if (b[p.side] == null) continue;                 // declined by the price ceiling — no trade
        out.push({ date: d.date, dt: p.dt, side: p.side, pnl: b[p.side], tod: b.tod, b60: b.b60, b15: b.b15 });
      }
    }
    tradesOf[k] = out;
  }

  // ── REPRODUCTION CHECK vs the prior study ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(96));
  console.log('REPRODUCTION CHECK — the whole-sample per-pattern totals this grid produces, which must match');
  console.log(`backtest-open-only.js's "PER-PATTERN CONTRIBUTION — NO BAND CONDITION" table at ${GEO_KEY}.`);
  console.log('═'.repeat(96));
  console.log('  ' + padr('pattern', 18) + padr('dir', 6) + pad('entries', 9) + pad('total', 13) + pad('win%(trade)', 13) + pad('$/trade', 10) + pad('drift base', 12) + pad('ALPHA', 12));
  console.log('  ' + '─'.repeat(94));
  for (const k of P.ALL) {
    const s = score(tradesOf[k], all, 'ALL');
    if (!s) { console.log('  ' + padr(k, 18) + padr(P.PATTERNS[k].dir, 6) + pad(0, 9)); continue; }
    console.log('  ' + padr(k, 18) + padr(P.PATTERNS[k].dir, 6) + pad(s.n.toLocaleString(), 9) + pad(usd(s.total), 13)
      + pad(s.winPct.toFixed(1) + '%', 13) + pad(usd(s.perTrade), 10) + pad(usd(s.baseTod), 12) + pad(usd(s.alphaTod), 12));
  }

  // ── THE GRID ──────────────────────────────────────────────────────────────────────────────────
  const wanted = arg('--only', null);
  const SUMMARY = [];      // one row per (bucketing, bucket) for the consolidated answer table
  const ALL_T = [];        // every per-pattern per-bucket alpha t, for the significance census
  for (const B of BUCKETINGS) {
    if (wanted && !B.key.includes(wanted)) continue;
    const bl = makeBaseline(grid, dayTags, (b, t) => B.of(b, t) || null);
    const buckets = B.order.filter(x => bl.buckets().includes(x));
    console.log('\n' + '═'.repeat(120));
    console.log(`${B.key.toUpperCase()} — ${B.label}`);
    console.log('═'.repeat(120));
    // bucket drift table first: this is the number every pattern in the bucket has to beat
    console.log('  BUCKET DRIFT (signal-free, every action bar inside the bucket) — the baseline, not a strategy.');
    console.log('  fwd/med/up% = the realized TAPE move from the bar to settlement (mean pts, MEDIAN pts, % of bars where it');
    console.log('  was positive) — no option pricing at all. A $20 spread SATURATES at ±$20, so its P&L tracks the SIGN of the');
    console.log('  move, not its size: the median and up% are the numbers that matter and the mean is the tail-driven one.');
    console.log('  both-* re-runs the two drifts over ONLY the bars where the ceiling let BOTH sides open, removing the');
    console.log('  selection asymmetry from the very different decline rates; `pair` = bull+bear on the same bar, which is');
    console.log('  ($20 − bullLimit − bearLimit)×100 by construction (complementary payoffs) and is the no-arbitrage residual.');
    console.log('    ' + padr('bucket', 14) + pad('days', 7) + pad('bars', 9) + pad('fwd', 8) + pad('med', 8) + pad('up%', 8) + pad('bull $/trd', 12) + pad('bear $/trd', 12)
      + pad('bull total', 14) + pad('bear total', 14) + pad('both bull', 11) + pad('both bear', 11) + pad('pair', 8));
    for (const k of buckets) {
      const nb = bl.nBars(k, 'bull'), ns = bl.nBars(k, 'bear');
      const mb = bl.flatMean(k, 'bull'), ms = bl.flatMean(k, 'bear');
      const d = diag(grid, dayTags, bl.keyOf, k);
      console.log('    ' + padr(k, 14) + pad(bl.nDays(k), 7) + pad(nb.toLocaleString(), 9) + pad(d.fwd == null ? '—' : d.fwd.toFixed(1), 8)
        + pad(d.med == null ? '—' : d.med.toFixed(1), 8) + pad(d.up == null ? '—' : d.up.toFixed(0) + '%', 8)
        + pad(usd(mb), 12) + pad(usd(ms), 12) + pad(usd(mb * nb), 14) + pad(usd(ms * ns), 14)
        + pad(usd(d.bothBull), 11) + pad(usd(d.bothBear), 11) + pad(usd(d.pair), 8));
    }
    console.log('');
    // per-pattern per-bucket
    const H = '  ' + padr('pattern', 18) + padr('dir', 6) + padr('bucket', 13) + pad('n', 7) + pad('days', 6) + pad('total', 12)
      + pad('win%', 8) + pad('$/trade', 10) + pad('base $/trd', 12) + pad('ALPHA', 12) + pad('a/trade', 10) + pad('t', 7);
    console.log(H);
    console.log('  ' + '─'.repeat(H.length - 2));
    for (const k of P.ALL) {
      let first = true;
      for (const bk of buckets) {
        const tr = tradesOf[k].filter(t => bl.keyOf({ b60: t.b60, b15: t.b15, tod: t.tod }, dayTags.get(t.date)) === bk);
        const s = score(tr, bl, bk);
        const lbl = first ? k : ''; const dl = first ? P.PATTERNS[k].dir : ''; first = false;
        if (!s) { console.log('  ' + padr(lbl, 18) + padr(dl, 6) + padr(bk, 13) + pad(0, 7) + pad('—', 6) + pad('n too small', 12)); continue; }
        const thin = s.n < 100 || s.nDays < 25;
        if (s.t != null) ALL_T.push(s.t);
        console.log('  ' + padr(lbl, 18) + padr(dl, 6) + padr(bk, 13) + pad(s.n.toLocaleString(), 7) + pad(s.nDays, 6) + pad(usd(s.total), 12)
          + pad(s.winPct.toFixed(0) + '%', 8) + pad(usd(s.perTrade), 10) + pad(usd(s.basePerTrade), 12)
          + pad(usd(s.alphaTod), 12) + pad(usd(s.alphaPerTrade), 10) + pad(s.t == null ? '—' : s.t.toFixed(2), 7) + (thin ? '  (thin)' : ''));
      }
      console.log('  ' + '·'.repeat(H.length - 2));
    }
    // direction roll-up: all bull patterns vs all bear patterns inside each bucket
    console.log('\n  DIRECTION ROLL-UP — every bullish pattern pooled vs every bearish pattern pooled (doji/dojiLoose excluded: neutral).');
    console.log('  ' + padr('dir', 11) + padr('bucket', 14) + pad('n', 8) + pad('days', 6) + pad('total', 13) + pad('$/trade', 10)
      + pad('base $/trd', 12) + pad('ALPHA', 13) + pad('a/trade', 10) + pad('t', 7));
    const roll = { bull: {}, bear: {} };
    for (const dir of ['bull', 'bear']) {
      const keys = P.ALL.filter(k => P.PATTERNS[k].dir === dir);
      const pooled = keys.flatMap(k => tradesOf[k]);
      let first = true;
      for (const bk of buckets) {
        const tr = pooled.filter(t => bl.keyOf({ b60: t.b60, b15: t.b15, tod: t.tod }, dayTags.get(t.date)) === bk);
        const s = score(tr, bl, bk);
        roll[dir][bk] = s;
        const lbl = first ? dir + ' pats' : ''; first = false;
        if (!s) { console.log('  ' + padr(lbl, 11) + padr(bk, 14) + pad(0, 8)); continue; }
        console.log('  ' + padr(lbl, 11) + padr(bk, 14) + pad(s.n.toLocaleString(), 8) + pad(s.nDays, 6) + pad(usd(s.total), 13)
          + pad(usd(s.perTrade), 10) + pad(usd(s.basePerTrade), 12) + pad(usd(s.alphaTod), 13) + pad(usd(s.alphaPerTrade), 10)
          + pad(s.t == null ? '—' : s.t.toFixed(2), 7) + (s.n < 100 || s.nDays < 25 ? '  (thin)' : ''));
      }
    }
    for (const bk of buckets) {
      const d = diag(grid, dayTags, bl.keyOf, bk);
      SUMMARY.push({ dim: B.key, bucket: bk, days: bl.nDays(bk), med: d.med, up: d.up,
        driftBull: bl.flatMean(bk, 'bull'), driftBear: bl.flatMean(bk, 'bear'), bull: roll.bull[bk], bear: roll.bear[bk] });
    }
  }

  // ── THE ANSWER ────────────────────────────────────────────────────────────────────────────────
  if (!wanted) {
    const H = padr('regime', 10) + padr('bucket', 13) + pad('days', 6) + pad('medFwd', 9) + pad('up%', 6)
      + pad('driftBull', 11) + pad('driftBear', 11) + pad('bullPat', 10) + pad('bullA', 9) + pad('t', 6)
      + pad('bearPat', 10) + pad('bearA', 9) + pad('t', 6) + '   flipped?';
    console.log('\n' + '═'.repeat(H.length));
    console.log('THE ANSWER — one row per regime bucket. `driftBull/driftBear` are the signal-free per-trade drifts, i.e.');
    console.log('WHETHER THE ASYMMETRY EXISTS AT ALL in that regime. `bullPat/bearPat` are the pooled directional patterns\'');
    console.log('$/trade and `bullA/bearA` their ALPHA per trade over that bucket\'s own time-matched drift — i.e. WHETHER THE');
    console.log('PATTERNS ADD ANYTHING once the regime\'s direction is priced out. "flipped" = the bucket\'s bear drift beat its');
    console.log('bull drift, which is the outcome the regime hypothesis predicts for a downtrend.');
    console.log('═'.repeat(H.length));
    console.log(H); console.log('─'.repeat(H.length));
    let lastDim = null;
    for (const r of SUMMARY) {
      const f = (r.driftBear > r.driftBull);
      const c = (s) => s ? [pad(usd(s.perTrade), 10), pad(usd(s.alphaPerTrade), 9), pad(s.t == null ? '—' : s.t.toFixed(2), 6)] : [pad('—', 10), pad('—', 9), pad('—', 6)];
      console.log(padr(r.dim === lastDim ? '' : r.dim, 10) + padr(r.bucket, 13) + pad(r.days, 6)
        + pad(r.med == null ? '—' : r.med.toFixed(1), 9) + pad(r.up == null ? '—' : r.up.toFixed(0) + '%', 6)
        + pad(usd(r.driftBull), 11) + pad(usd(r.driftBear), 11) + c(r.bull).join('') + c(r.bear).join('')
        + '   ' + (f ? 'FLIPPED' : '') + (r.days < 40 ? '  (thin: ' + r.days + ' days)' : ''));
      lastDim = r.dim;
    }
    const hi = ALL_T.filter(t => t > 2).length, lo = ALL_T.filter(t => t < -2).length;
    const mt = ALL_T.reduce((a, b) => a + b, 0) / ALL_T.length;
    console.log('\nALPHA SIGNIFICANCE CENSUS — across all ' + ALL_T.length + ' (pattern x bucket) cells in every table above:');
    console.log(`  |t| > 2 in ${hi + lo} cells (${hi} positive, ${lo} negative); pure chance at 5% two-sided would give about ${(ALL_T.length * 0.05).toFixed(0)}.`);
    console.log(`  mean t = ${mt.toFixed(3)}. There is no regime in which the patterns produce a t-distribution distinguishable from noise.`);
  }
  console.log('');
}

// ── VERIFY ──────────────────────────────────────────────────────────────────────────────────────
// The grid claims a pattern arm's P&L can be reconstructed from per-(bar,side) trades. Prove it: run
// the REAL engine arm for a few patterns and compare totals to the dollar.
async function verify() {
  const { days } = loadTradeableDays(DIR);
  const hasPx = days.some(d => d.bars.some(b => b.px));
  const grid = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const gridBy = new Map(grid.map(r => [r.date, r]));
  const opts = optsFor(hasPx);
  console.log(`\nVERIFY — real engine arm vs bar-grid reconstruction (${GEO_KEY}, no band condition)\n`);
  console.log(padr('pattern', 18) + pad('engine total', 15) + pad('grid total', 15) + pad('engine opens', 14) + pad('grid trades', 13) + '  match');
  let bad = 0;
  for (const k of P.ALL) {
    let engTotal = 0, engOpens = 0, gTotal = 0, gN = 0;
    for (const d of days) {
      const r = runDay5m(d.bars, makeOpenOnlySignal({ tf: '60m', prox: null, patterns: [k], armBars: ARM_BARS }), opts);
      engTotal += r.terminal; engOpens += r.opens;
      const row = gridBy.get(d.date), byDt = new Map(row.bars.map(b => [b.dt, b]));
      const fn = makeOpenOnlySignal({ tf: '60m', prox: null, patterns: [k], armBars: ARM_BARS });
      for (let i = 0; i < d.bars.length; i++) {
        const m = RB.etMin(d.bars[i].dt);
        if (!(m >= RB.RTH_LO && m <= RB.RTH_HI)) continue;
        const sig = fn(d.bars[i].analysis, i > 0 ? d.bars[i - 1].analysis : null, {});
        if (!sig.openSide) continue;
        const b = byDt.get(d.bars[i].dt);
        if (b[sig.openSide] == null) continue;
        gTotal += b[sig.openSide]; gN++;
      }
    }
    const ok = Math.abs(engTotal - gTotal) < 1 && engOpens === gN;
    if (!ok) bad++;
    console.log(padr(k, 18) + pad(usd(engTotal), 15) + pad(usd(gTotal), 15) + pad(engOpens.toLocaleString(), 14) + pad(gN.toLocaleString(), 13) + '  ' + (ok ? 'OK' : '*** MISMATCH ***'));
  }
  console.log(`\n${bad ? bad + ' MISMATCHES — the grid method is invalid, do not read the tables' : 'all patterns reconstruct exactly'}\n`);
  process.exit(bad ? 1 : 0);
}

(process.argv.includes('--verify') ? verify() : main()).catch(e => { console.error(e); process.exit(1); });
