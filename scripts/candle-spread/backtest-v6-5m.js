#!/usr/bin/env node
'use strict';
/**
 * v6 5m-STEP backtest — steps the engine every 5m (not 15m), pricing/filling/settling off the 5m
 * candle, so v6 can ACT between 15m closes on a confirmed 5m reversal (ctx.isFifteen=false on
 * intra-15m bars; see v6-signals.js). Compares v6-5m against the FROZEN v5 baseline, which is run on
 * the 15m-close subset of the same 5m dataset (identical underlying data). Tent geometry + resting-fill
 * + BS pricing are the same as the frozen engine; only the STEP and the signal differ.
 *
 * Data: a 5m-resolution dataset (build-analysis-dataset.js --step 5).
 * Usage: node scripts/candle-spread/backtest-v6-5m.js --dataDir <5m dir> [--cfg fiveMin=true,...]
 */
const fs = require('fs');
const path = require('path');
const eng = require('./backtest-v4');                         // geometry + pricing + frozen v5 runner
const trader = require('../../server/src/candle-spread/trader'); // server COVER selectors (pure; BS getLeg)
const { v6Signal } = require('./v6-signals');
const { v5Signal } = require('./v5-signals');
const bs = eng.bs, { WIDTH, INCR, TICK, QTY } = eng;
const roundTick = eng.roundTick, round2 = eng.round2;

function parseCfg() {
  const cfg = {}; const ci = process.argv.indexOf('--cfg');
  if (ci >= 0 && process.argv[ci + 1]) for (const kv of process.argv[ci + 1].split(',')) {
    const [k, v] = kv.split('='); if (k) cfg[k.trim()] = v === undefined ? true : (v === 'true' ? true : v === 'false' ? false : (isNaN(Number(v)) ? v : Number(v)));
  }
  return cfg;
}
const CFG = parseCfg();
const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-v2');
const money = n => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n));
const etDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const etMinute = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const isFive = a => ['1m', '5m', '15m', '60m'].every(tf => a[tf] && a[tf].bbupper != null && a[tf].bblower != null && a[tf].ema != null);

// Load ALL 5m bars per day (not just 15m closes). Returns { date, bars:[{dt,analysis,fifteen}] }.
function load5mDays(dir) {
  const files = fs.readdirSync(dir).filter(f => /^backtest-[A-Z]+-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const bars = arr.filter(x => x.datetime != null && isFive(x.analysis))
      .map(x => ({ dt: x.datetime, analysis: x.analysis, fifteen: new Date(x.datetime).getMinutes() % 15 === 0 }));
    if (bars.length < 5) continue;
    out.push({ date: etDay(bars[0].dt), bars });
  }
  return out;
}

const legsPayoff = eng.legsPayoff, legsMark = eng.legsMark, buildOpen = eng.buildOpen, coverLegs = eng.coverLegs;
const CL = require('../../server/src/candle-spread/capital-legs');   // proven debit/credit leg + signed-cash foundation
const LL = require('../../server/src/candle-spread/leg-ledger');     // intraday leg-uniqueness ledger + placement resolver
const RH = require('../../server/src/candle-spread/risk-harvest');   // v11 risk-harvest hedge search (far-side loss-zone lock)

// 5m-step run for one day. Prices off A['5m'].close; cover fills off the 5m candle's extreme.
// signalFn(A, prior, { heldDir, isFifteen }) → { openSide, cover }.
// opts.riskCap (v7 "be patient"): $ cap on UNCOVERED debit — pause opening new positions once the sum
//   of open debits on not-yet-covered positions would exceed it; covers free risk and re-enable opens.
// opts.bidirectional (v7 "be wrong"): allow opening the opposite side while holding the other.
// v8 opts: proactiveCoverFrac (place a resting cover on any uncovered position whose OPENING spread
//   marks >= frac*WIDTH = deep ITM → locks the leader, and it stops counting toward the soft cap);
//   softCap = "churn cap" on AT-RISK (uncovered AND not-deep-ITM) debit — freed as leaders go deep ITM;
//   hardCap = absolute backstop on TOTAL uncovered debit (deep-ITM included). Any cap default Infinity.
function runDay5m(bars, signalFn, opts = {}) {
  const riskCap = opts.riskCap != null ? opts.riskCap : Infinity;   // legacy single cap (v7)
  const softCap = opts.softCap != null ? opts.softCap : Infinity;   // v8 churn cap (at-risk only)
  const hardCap = opts.hardCap != null ? opts.hardCap : Infinity;   // STRATEGY RISK backstop (v8/v9 risk/reward tuning)
  // ACCOUNT capital ceiling — how much at-risk (uncovered) capital the account can hold. SEPARATE and
  // distinct in purpose from the strategy risk caps above (this is buying power, not risk appetite);
  // whichever is tighter throttles. Tracked separately so its skips can be isolated.
  const capCeiling = opts.capitalCeiling != null ? opts.capitalCeiling : Infinity;
  const pFrac = opts.proactiveCoverFrac != null ? opts.proactiveCoverFrac : null;
  const bidir = opts.bidirectional === true;
  // rthActionOnly: model LIVE faithfully — the multi-TF `A` is still built from the 24h series (so the
  // bands carry the overnight session), but we only ACT (open/cover/settle) during RTH, since NDX 0DTE
  // options only trade 9:30-16:00. Overnight bars stay in the loop purely for prior continuity. Default
  // OFF = the legacy 24h-action behavior (the pure-NQ signal validation).
  const rthOnly = opts.rthActionOnly === true;
  const inRth = ms => { const m = etMinute(ms); return m >= 575 && m <= 955; };   // 9:35 .. 15:55 action window
  // coverSelector (v1/v2/v3): pick the cover GEOMETRY via the server's pure selectors (greedy/joint/
  // fixed-mark) using a BS getLeg, instead of the fixed tent. undefined = fixed tent (v0/default).
  const coverSel = opts.coverSelector || null;
  const dirWindow = opts.dirWindow || 12;   // rolling-directionality window (5m bars); ~1h at 12
  // directionality at bar i = |net move over the window| / (window high-low range). ~1 = trending, ~0 = chop.
  const directionalityAt = i => {
    const j0 = Math.max(0, i - dirWindow); if (i - j0 < 3) return 1;
    let hi = -Infinity, lo = Infinity;
    for (let j = j0; j <= i; j++) { const x = bars[j].analysis['5m']; hi = Math.max(hi, x.high); lo = Math.min(lo, x.low); }
    const rng = hi - lo; if (!(rng > 0)) return 1;
    return Math.abs(bars[i].analysis['5m'].close - bars[j0].analysis['5m'].close) / rng;
  };
  // GEOMETRY (opts.geo) — spread WIDTH + strike selection + tent covers. Default = the $20 ATM geometry.
  const G = { WIDTH: (opts.geo && opts.geo.WIDTH) || WIDTH, buildOpen: (opts.geo && opts.geo.buildOpen) || buildOpen, coverLegs: (opts.geo && opts.geo.coverLegs) || coverLegs };
  const st = { dir: 'none', positions: [] };
  const ivOf = A => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
  const uncoveredRisk = () => st.positions.reduce((s, p) => s + (p.covered ? 0 : p.limit * 100 * QTY), 0);
  let capBlocked = 0, capBlockedTrend = 0, capSkipCeiling = 0, nCoverToStack = 0;   // capSkipCeiling = opens refused ONLY by the account ceiling
  // CAPITAL accounting (opts.trackCapital) — cash deployed through the day; does NOT touch P&L. Two
  // cover rules tracked in parallel: all-DEBIT (pay every cover) vs CREDIT-cover-on-ITM (a cover on a
  // position marking >= creditFrac×width is done as a credit spread → reclaims ~(width−coverLimit) cash
  // instead of paying; 0DTE P&L-identical, NDX cash-settled so no assignment risk). peak = max
  // simultaneous deployment = the account size needed for the day.
  const trackCap = opts.trackCapital === true;
  const creditFrac = opts.creditCoverFrac != null ? opts.creditCoverFrac : 0.65;
  const altEvery = opts.openAlternateEvery || 3;   // alternate open type debit/credit every N opens
  // CASH views: depD/peakD = all-debit. depC/peakC = credit-cover-on-ITM. depA/peakA = user's CONTINUOUS
  // ALTERNATING opens (N debit, N credit, ...) + ITM credit covers → keeps cash oscillating low all day,
  // decoupled from any ceiling. peakUncov = peak UNCOVERED at-risk (the margin view; = what the account
  // capital ceiling caps). Cash management (alternating) is independent of the at-risk ceiling.
  let depD = 0, peakD = 0, depC = 0, peakC = 0, depA = 0, peakA = 0, peakUncov = 0, nCredit = 0, nDebitCov = 0, openN = 0;
  // depR/peakR = the ACCURATE cash curve for the shipping policy (alternate debit/credit opens every
  // altEvery + credit cover on ITM winners), priced from the REAL legs actually traded via capital-legs
  // (not the ~width approximation of depA/depC). depR += entryMark(legsTraded): +debit deploys, -credit
  // reclaims. peakR = worst simultaneous cash = the account funding this policy actually needs.
  let depR = 0, peakR = 0;
  // LEG-UNIQUENESS (opts.enforceLegUniqueness): a per-day ledger of which side each (type,strike) leg was
  // traded, so a leg is never both bought- and sold-to-open (the broker nets same-symbol positions). On a
  // conflict the resolver prefers the parity twin at the SAME strikes (keeps geometry + P&L), else shifts.
  const enforceLegs = opts.enforceLegUniqueness === true;
  const legIncr = opts.legIncr || 10;
  // recaptureAlternate: the resolver PREFERS the debit/credit style the recapture alternation would send
  // (every altEvery opens), so opens spread across both option ladders → fewer leg conflicts / shifts.
  const recapAlt = opts.recaptureAlternate === true;
  const ledger = LL.makeLegLedger();
  let legIdeal = 0, legTwin = 0, legShift = 0, legSkip = 0, legCoverTwin = 0, legCoverWing = 0, legCoverSkip = 0, shiftSum = 0, legOpenN = 0;
  // RISK-HARVEST (opts.riskHarvest): spend a sliver of the profit peak on far-side hedges to negate the
  // reachable loss zone when a ≥ratio hedge is available (ratio-gated, not clock-gated). Off by default.
  const harvest = opts.riskHarvest === true;
  const hvRatio = opts.harvestRatio != null ? opts.harvestRatio : 3;
  const hvBandSig = opts.harvestBandSigmas != null ? opts.harvestBandSigmas : 1.5;
  const hvTrigger = opts.harvestTrigger != null ? opts.harvestTrigger : -1000;   // only act if reachable loss worse than this
  const hvBudget = opts.harvestDayBudget != null ? opts.harvestDayBudget : Infinity;
  let hvSpent = 0, hvCount = 0, hvDays = 0;
  // PRICING underlying (opts.priceOf): options are priced/settled off THIS series while the SIGNAL stays on
  // A (the analysis series). Default = the analysis 5m itself → baselines byte-identical. Override to price
  // NDX options off the real NDX close while signalling off NQ (the live model; NDX ≈ NQ − basis, ~44pt).
  const priceOf = opts.priceOf || (b => { const c = b.analysis['5m']; return { close: c.close, high: c.high, low: c.low }; });
  for (let i = 0; i < bars.length; i++) {
    // rthActionOnly: skip overnight bars entirely (no trading/fills), but they remain in `bars` so the
    // next RTH bar's prior (bars[i-1]) is the real continuous-24h prior — matches live's true continuity.
    if (rthOnly && !inRth(bars[i].dt)) continue;
    const A = bars[i].analysis, c5 = A['5m'], px = priceOf(bars[i]), S = px.close, tau = bs.tauFromTime(bars[i].dt), iv = ivOf(A);
    const capMark = (t, k) => legsMark([{ side: 'long', type: t, strike: k }], S, tau, iv);   // single-leg mid for capital-legs
    const isDeep = pos => pFrac != null && !pos.covered && legsMark(pos.legs, S, tau, iv) >= pFrac * G.WIDTH;
    // (a0) PROACTIVE DEEP-ITM COVER (v8) — a leader is deep enough ITM to lock a good tent → rest a cover.
    if (pFrac != null) {
      for (const pos of st.positions) {
        if (pos.covered || pos.pendingCover) continue;
        if (legsMark(pos.legs, S, tau, iv) >= pFrac * G.WIDTH) pos.pendingCover = { legs: G.coverLegs(pos.side, pos.shortStrike), target: round2(G.WIDTH - pos.limit) };
      }
    }
    for (const pos of st.positions) {                       // (a) resolve resting covers vs THIS 5m bar
      if (!pos.pendingCover) continue;
      const pc = pos.pendingCover, ext = pos.side === 'bull' ? px.high : px.low;
      if (legsMark(pc.legs, ext, tau, iv) <= pc.target) {
        if (enforceLegs) {
          // Resolve the cover: ideal tent → credit twin (same strikes) → wing-shift (anchor cover) → skip.
          const rc = LL.resolveCover(pos.side, pos.shortStrike, G.WIDTH, ledger, { preferStyle: 'debit', incr: legIncr, maxWingShift: opts.legMaxWing || 8 });
          if (rc.resolution === 'skip') { legCoverSkip++; pos.pendingCover = null; continue; }   // can't lock — stays uncovered
          if (rc.resolution === 'twin') legCoverTwin++;
          else if (rc.resolution === 'wingShift') legCoverWing++;
          ledger.record(rc.legs);
          if (rc.wing !== G.WIDTH) {
            // Anchor cover (wider wing): P&L uses the ACTUAL legs (debit-canonical at the shifted wing).
            const pnlLegs = CL.coverLegsFor(pos.side, pos.shortStrike, rc.wing, 'debit');
            pos.coverLegs = pnlLegs; pos.coverLimit = roundTick(legsMark(pnlLegs, S, tau, iv) + TICK);
            pos.covered = true; pos.pendingCover = null; continue;
          }
        }
        pos.coverLimit = roundTick(Math.min(pc.target, legsMark(pc.legs, S, tau, iv) + TICK));
        pos.coverLegs = pc.legs; pos.covered = true; pos.pendingCover = null;
        if (trackCap) {
          const cd = pos.coverLimit * 100 * QTY;
          depD += cd; peakD = Math.max(peakD, depD);
          const itm = legsMark(pos.legs, S, tau, iv) >= creditFrac * G.WIDTH;   // ITM enough → credit cover reclaims cash
          if (itm) { const back = (G.WIDTH - pos.coverLimit) * 100 * QTY; depC -= back; depA -= back; nCredit++; }
          else { depC += cd; depA += cd; nDebitCov++; }
          peakC = Math.max(peakC, depC); peakA = Math.max(peakA, depA);
          // depR: same policy priced from the REAL legs (credit cover on ITM else the debit cover).
          const covLegsR = itm ? CL.coverLegsFor(pos.side, pos.shortStrike, G.WIDTH, 'credit') : pos.coverLegs;
          depR += CL.entryMark(covLegsR, capMark) * 100 * QTY; peakR = Math.max(peakR, depR);
        }
      }
    }
    if (trackCap) peakUncov = Math.max(peakUncov, uncoveredRisk());   // margin view: at-risk uncovered $ right now
    // per-side held state (uncovered positions on each side) + legacy single heldDir for v4-v6.
    const heldBull = st.positions.some(p => p.side === 'bull' && !p.covered);
    const heldBear = st.positions.some(p => p.side === 'bear' && !p.covered);
    const sig = signalFn(A, i > 0 ? bars[i - 1].analysis : null, { heldDir: st.dir, heldBull, heldBear, isFifteen: bars[i].fifteen, directionality: directionalityAt(i) });
    // (c) COVER — sig.coverSide ('bull'|'bear'|'both') covers just that side (v7 per-side); legacy
    //     sig.cover (bool) covers all. Place resting covers on the targeted uncovered positions.
    const coverSet = sig.coverSide ? (sig.coverSide === 'both' ? ['bull', 'bear'] : [sig.coverSide]) : (sig.cover ? ['bull', 'bear'] : []);
    if (coverSet.length) {
      const toCover = st.positions.filter(p => !p.covered && !p.pendingCover && coverSet.includes(p.side));
      let plans = null;
      if (coverSel) {   // v1/v2/v3: reuse the server cover selectors with a BS getLeg (single source of truth)
        const getLeg = (type, k) => ({ mid: bs.bsPrice(type, S, k, tau, iv), symbol: `x${type}${k}`, bid: 0, ask: 0 });
        const cfgLike = { spreadWidth: G.WIDTH, strikeIncrement: INCR, tickIncrement: TICK, quantity: QTY, coverSelector: coverSel, coverKCap: 5 };
        const withId = toCover.map((p, k) => ({ ...p, id: 'c' + k, quantity: QTY }));
        plans = trader.selectCovers(withId, cfgLike, getLeg, { underlying: S, reversedDir: sig.openSide || (coverSet[0] === 'bull' ? 'bear' : 'bull'), bbOverride: false });
      }
      for (let k = 0; k < toCover.length; k++) {
        const pos = toCover[k];
        let legs = G.coverLegs(pos.side, pos.shortStrike);
        if (plans) { const pl = plans.find(x => x.positionId === 'c' + k); if (pl && !pl.error && pl.legs) legs = pl.legs; }
        pos.pendingCover = { legs, target: round2(G.WIDTH - pos.limit) };
      }
      if (sig.cover || sig.coverSide === 'both' || sig.coverSide === st.dir) st.dir = 'none';   // reset stance so the flip's opposite open proceeds
    }
    const dirOk = bidir || st.dir === 'none' || st.dir === sig.openSide;
    if (sig.openSide && dirOk) {                            // (d) open (subject to the caps)
      let o = G.buildOpen(sig.openSide, S, tau, iv);
      // LEG-UNIQUENESS: resolve the ideal spread against the day's ledger — ideal → parity twin (same
      // strikes) → shift → skip. P&L stays on the debit-canonical spread at the RESOLVED strikes; the
      // ledger records the actual (style-specific) legs on commit. `resolvedLegs` = what to record.
      let resolvedLegs = o.legs, legSkip1 = false;
      if (enforceLegs) {
        const _s = o.legs.map(l => l.strike), _lo = Math.min(..._s), _hi = Math.max(..._s);
        const preferStyle = recapAlt ? (Math.floor(legOpenN / altEvery) % 2 === 1 ? 'credit' : 'debit') : 'debit';
        const res = LL.resolveOpen(sig.openSide, _lo, _hi, ledger, { incr: legIncr, maxShift: opts.legMaxShift || 6, preferStyle });
        if (res.resolution === 'skip') { legSkip++; legSkip1 = true; }
        else {
          if (res.resolution === 'shift') { legShift++; shiftSum += Math.abs(res.shift); o = G.buildOpen(sig.openSide, S + res.shift * legIncr, tau, iv); }
          else if (res.resolution === 'twin') legTwin++; else legIdeal++;
          resolvedLegs = res.legs;
        }
      }
      if (!legSkip1) {
      const nd = o.limit * 100 * QTY;
      // COVER-TO-CONTINUE-STACKING (opts.coverToStack): if a new open would breach the ACCOUNT ceiling
      // mid-trend, LOCK the deepest-ITM winner(s) first — a covered tent is riskless, so it frees its
      // at-risk from the budget — rather than skipping the trade. Only locks positions marking >=
      // coverToStackMinFrac×width (real winners → cheap covers, positive floor), deepest first, just
      // enough to fit the new open. Changes P&L (covers a winner sooner) — that's the trade-off.
      // The cap cover-to-stack recycles against: the account ceiling always, and — when
      // opts.coverToStackVsRisk — the STRATEGY risk cap too (user's "if risk hits the cap, cover to
      // enable more"). Effective trigger = the tightest active cap it's allowed to recycle against.
      const ctsCap = Math.min(capCeiling, opts.coverToStackVsRisk ? Math.min(riskCap, hardCap) : Infinity);
      if (opts.coverToStack && ctsCap < Infinity && uncoveredRisk() + nd > ctsCap) {
        const lockMin = (opts.coverToStackMinFrac != null ? opts.coverToStackMinFrac : creditFrac) * G.WIDTH;
        const cands = st.positions.filter(p => !p.covered && !p.pendingCover)
          .map(p => ({ p, mark: legsMark(p.legs, S, tau, iv) }))
          .filter(x => x.mark >= lockMin)
          .sort((a, b) => b.mark - a.mark);                 // deepest ITM first: cheapest cover, biggest lock
        const lockedNow = [];
        for (const { p } of cands) {
          if (uncoveredRisk() + nd <= ctsCap) break;        // freed enough room under the binding cap
          let cl = G.coverLegs(p.side, p.shortStrike);       // debit-canonical (drives P&L)
          if (enforceLegs) {
            // Resolve the lock-cover for leg-uniqueness (prefer TWIN = same strikes, P&L-neutral; else
            // wing-shift = anchor cover; else skip this winner) so the SENT legs are recorded — matching
            // live's placeRestingCover, and letting the follow-on open be re-resolved to avoid them.
            const rc = LL.resolveCover(p.side, p.shortStrike, G.WIDTH, ledger, { preferStyle: 'debit', incr: legIncr, maxWingShift: opts.legMaxWing || 8 });
            if (rc.resolution === 'skip') { legCoverSkip++; continue; }   // can't lock leg-uniquely → leave uncovered
            if (rc.resolution === 'twin') legCoverTwin++; else if (rc.resolution === 'wingShift') legCoverWing++;
            ledger.record(rc.legs);
            if (rc.wing !== G.WIDTH) cl = CL.coverLegsFor(p.side, p.shortStrike, rc.wing, 'debit');   // anchor-cover P&L legs
          }
          p.coverLegs = cl; p.coverLimit = roundTick(Math.min(round2(G.WIDTH - p.limit), legsMark(cl, S, tau, iv) + TICK));
          p.covered = true; p.pendingCover = null; nCoverToStack++;
          if (trackCap) { const back = (G.WIDTH - p.coverLimit) * 100 * QTY; depC -= back; depA -= back; nCredit++; }   // deep winner → credit cover
          lockedNow.push({ side: p.side, shortStrike: p.shortStrike });
        }
        // RE-RESOLVE the open against the now-updated ledger (it may have just gained cover-to-stack legs),
        // so the open can't NET against a lock we just placed — the 4-leg combo then merges two conflict-free
        // spreads (no combo-level wing-shift needed). Prefer the parity twin (same strikes → P&L-neutral).
        if (enforceLegs && lockedNow.length) {
          const _s2 = o.legs.map(l => l.strike), _lo2 = Math.min(..._s2), _hi2 = Math.max(..._s2);
          const preferStyle2 = recapAlt ? (Math.floor(legOpenN / altEvery) % 2 === 1 ? 'credit' : 'debit') : 'debit';
          const res2 = LL.resolveOpen(sig.openSide, _lo2, _hi2, ledger, { incr: legIncr, maxShift: opts.legMaxShift || 6, preferStyle: preferStyle2 });
          if (res2.resolution === 'shift') { o = G.buildOpen(sig.openSide, S + res2.shift * legIncr, tau, iv); resolvedLegs = res2.legs; }
          else if (res2.resolution !== 'skip') resolvedLegs = res2.legs;
        }
        // Instrumentation hook (opts.onCoverToStack): READ-ONLY — measures 4-leg combo applicability.
        if (opts.onCoverToStack && lockedNow.length) {
          opts.onCoverToStack({ locked: lockedNow, openLegs: o.legs, openSide: sig.openSide, width: G.WIDTH, mark: (type, k) => bs.bsPrice(type, S, k, tau, iv) });
        }
      }
      // soft cap counts only AT-RISK debit (uncovered & NOT deep-ITM); hard cap + legacy count ALL uncovered.
      const totalUncov = uncoveredRisk();
      const atRisk = st.positions.reduce((s, p) => s + ((p.covered || isDeep(p)) ? 0 : p.limit * 100 * QTY), 0);
      // exemptTrendStack (v8): if every uncovered position is the SAME side as this open, we're stacking a
      // trend, not churning chop → skip the soft cap (only the hard ceiling limits a trend run).
      const stacking = st.positions.filter(p => !p.covered).every(p => p.side === sig.openSide);
      const softOk = (opts.exemptTrendStack && stacking) ? true : (atRisk + nd <= softCap);
      const strategyOk = (totalUncov + nd <= riskCap) && softOk && (totalUncov + nd <= hardCap);   // strategy RISK caps
      const ceilingOk = totalUncov + nd <= capCeiling;                                             // ACCOUNT capital ceiling (separate)
      if (strategyOk && ceilingOk) {
        st.positions.push({ side: sig.openSide, shortStrike: o.shortStrike, legs: o.legs, limit: o.limit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null });
        if (enforceLegs) { ledger.record(resolvedLegs); legOpenN++; }   // record actual played legs; advance alternation
        st.dir = sig.openSide;
        if (trackCap) {
          depD += nd; depC += nd; peakD = Math.max(peakD, depD); peakC = Math.max(peakC, depC);
          // ALTERNATING opens: first N debit (pay), next N credit (receive ~the debit-equivalent at
          // ATM by parity), repeat → net cash oscillates instead of draining.
          const creditOpen = Math.floor(openN / altEvery) % 2 === 1;
          depA += creditOpen ? -nd : nd; peakA = Math.max(peakA, depA); openN++;
          // depR: real-legs cash — on a credit turn, the parity credit spread (+cash); else the debit (-cash).
          const oStrikes = o.legs.map(l => l.strike), oLo = Math.min(...oStrikes), oHi = Math.max(...oStrikes);
          const openLegsR = creditOpen ? CL.openLegsFor(sig.openSide, oLo, oHi, 'credit') : o.legs;
          depR += CL.entryMark(openLegsR, capMark) * 100 * QTY; peakR = Math.max(peakR, depR);
        }
      } else {
        capBlocked++;   // a cap refused this open; was it a same-direction (trend-stacking) add?
        if (strategyOk && !ceilingOk) capSkipCeiling++;   // refused ONLY by the account ceiling (would've passed the strategy risk cap)
        if (st.positions.every(p => p.covered || p.side === sig.openSide) && st.positions.some(p => !p.covered)) capBlockedTrend++;
      }
      }   // end if(!legSkip1)
    }
    // RISK-HARVEST (opts.riskHarvest): after opens/covers, if a REACHABLE loss exists (worse than
    // hvTrigger over ±band = spot·iv·√tau·sigmas) and a ≥hvRatio far-side hedge is available, buy it to lift
    // the reachable floor toward 0 — spending a sliver of the peak. Ratio-gated (fires when lopsided, any
    // time of day), per-day budget. Hedges are held to settle. Off by default → baselines byte-identical.
    if (harvest) {
      const band = Math.round(S * iv * Math.sqrt(tau) * hvBandSig);
      const hvMaxPerDay = opts.harvestMaxPerDay != null ? opts.harvestMaxPerDay : Infinity;   // cap churn
      if (band > 0 && hvSpent < hvBudget && hvCount < hvMaxPerDay && RH.reachableFloor(st.positions, S, band, 10) < hvTrigger) {
        const mark = (type, strike) => bs.bsPrice(type, S, strike, tau, iv);
        // CONVICTION: only hedge the loss side the underlying is trending TOWARD (15m close vs 9EMA).
        const trend = (opts.harvestDirGate !== false && A['15m'] && A['15m'].ema != null) ? Math.sign(A['15m'].close - A['15m'].ema) : null;
        const plan = RH.harvestPlan(st.positions, mark, S, { band, step: 10, incr: legIncr, widths: [20, 40, 60], depth: 8, minRatio: hvRatio, target: 0, budget: hvBudget - hvSpent, slip: opts.harvestSlip != null ? opts.harvestSlip : 0.5, trend });
        for (const h of plan.hedges) {
          st.positions.push({ side: 'hedge', shortStrike: null, legs: h.legs, limit: h.debit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true });
          hvSpent += h.cost; hvCount++;
        }
      }
    }
  }
  // Settle: the 0DTE options settle at the 16:00 RTH close. For rthOnly, use the last bar at/through
  // 16:00 (not the 23:59 overnight close); otherwise (24h mode) the last bar of the day.
  let settleBar = bars[bars.length - 1];
  if (rthOnly) { for (let k = bars.length - 1; k >= 0; k--) { const m = etMinute(bars[k].dt); if (m >= 575 && m <= 960) { settleBar = bars[k]; break; } } }
  const settle = priceOf(settleBar).close;
  let floor = 0, terminal = 0, opens = 0, filled = 0, naked = 0;
  for (const pos of st.positions) {
    opens++; let value = legsPayoff(pos.legs, settle), cost = pos.limit;
    if (pos.covered && pos.coverLegs) { value += legsPayoff(pos.coverLegs, settle); cost += pos.coverLimit; floor = round2(floor + (G.WIDTH - pos.limit - pos.coverLimit) * 100 * QTY); filled++; } else naked++;
    terminal = round2(terminal + (value - cost) * 100 * QTY);
  }
  return {
    floor, terminal, opens, filled, naked, settle, capBlocked, capBlockedTrend, capSkipCeiling, nCoverToStack,
    capital: trackCap ? { peakDebit: peakD, peakCredit: peakC, peakAlt: peakA, peakReal: peakR, peakUncov, eodDebit: depD, eodCredit: depC, eodReal: depR, nCredit, nDebitCov } : null,
    legs: enforceLegs ? { ideal: legIdeal, twin: legTwin, shift: legShift, skip: legSkip, coverTwin: legCoverTwin, coverWing: legCoverWing, coverSkip: legCoverSkip, shiftSum, played: ledger.size() } : null,
    harvest: harvest ? { spent: Math.round(hvSpent), count: hvCount } : null
  };
}

// frozen v5 on the 15m-close subset of the same data (via the frozen engine)
function runV5_15m(bars) {
  const sub = bars.filter(b => b.fifteen).map(b => ({ dt: b.dt, analysis: b.analysis }));
  if (sub.length < 5) return { floor: 0, terminal: 0, opens: 0, filled: 0, naked: 0 };
  return eng.runDay(sub, (A, p, ctx) => v5Signal(A, p, { ...ctx, cfg: {} }));
}

module.exports = { runDay5m, load5mDays };

if (require.main === module) {
  const v6fn = (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: CFG });
  const rows = load5mDays(DIR).map(d => ({ date: d.date, v6: runDay5m(d.bars, v6fn), v5: runV5_15m(d.bars) }));
  console.log(`v6 5m-STEP vs FROZEN v5 (15m) — ${rows.length} NDX days`);
  console.log(`v6 cfg: ${Object.keys(CFG).length ? JSON.stringify(CFG) : '(defaults; add fiveMin=true to enable intra-5m)'}\n`);
  console.log('DATE         v6 O/F/N   v6 floor/term      v5 O/F/N   v5 floor/term');
  console.log('-'.repeat(78));
  const tot = { v6f: 0, v6t: 0, v5f: 0, v5t: 0 }; let wv6 = 0, wv5 = 0;
  for (const r of rows) {
    tot.v6f += r.v6.floor; tot.v6t += r.v6.terminal; tot.v5f += r.v5.floor; tot.v5t += r.v5.terminal;
    if (r.v6.terminal > r.v5.terminal) wv6++; else if (r.v5.terminal > r.v6.terminal) wv5++;
    console.log(r.date.padEnd(12) + `${r.v6.opens}/${r.v6.filled}/${r.v6.naked}`.padEnd(11) + `${money(r.v6.floor)}/${money(r.v6.terminal)}`.padEnd(19) +
      `${r.v5.opens}/${r.v5.filled}/${r.v5.naked}`.padEnd(11) + `${money(r.v5.floor)}/${money(r.v5.terminal)}`);
  }
  console.log('-'.repeat(78));
  console.log(`TOTALS      v6:  ${money(tot.v6f)} / ${money(tot.v6t)}      v5:  ${money(tot.v5f)} / ${money(tot.v5t)}`);
  console.log(`daily terminal wins:  v6 ${wv6}  ·  v5 ${wv5}  ·  ties ${rows.length - wv6 - wv5}`);
}
