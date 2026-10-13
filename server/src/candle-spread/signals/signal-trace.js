'use strict';
/**
 * SIGNAL TRACE (2026-10-13, user: "show what signals the strategy is actually seeing or has tripped at that
 * moment ... it would help me see if the engine is seeing the same things looking at our candles and averages
 * that I am seeing").
 *
 * v7Signal returns ONE answer — the first trigger that fires, in priority order. This evaluates EVERY trigger
 * independently on the same inputs and reports each one's conditions, so the UI can show what fired, what was
 * close, what was blocked and by what, and what is switched off for this variant.
 *
 * It re-states v7Signal's conditions rather than instrumenting it, so the live signal stays byte-identical. The
 * two are held together by a PARITY TEST (candle-spread-signal-trace.test.js): across the backtest dataset the
 * trace's `fired` must name the same trigger v7Signal returned on every bar. A change to v7Signal that is not
 * mirrored here fails that test.
 *
 * Shape: { family, stage: '15m'|'5m', held: {bull, bear}, inputs: {...}, triggers: [{ id, label, side, cover,
 *   enabled, active, parts: [{ name, ok, value }] , blockedBy? }], fired: id|null, reason }
 */
const conf = require('./confluence');
const pat = require('./candle-patterns');

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
function trendOf(c) {
  if (!c || c.bbmiddle == null || c.ema == null || c.close == null) return { up: false, down: false };
  return { up: c.close > c.bbmiddle && c.ema >= c.bbmiddle, down: c.close < c.bbmiddle && c.ema <= c.bbmiddle };
}
const trendWord = (t) => (t.up ? 'up' : t.down ? 'down' : 'mixed');
function crossedDown(cur, prv) { return !!(cur && prv && cur.bbmiddle != null && prv.bbmiddle != null && prv.close >= prv.bbmiddle && cur.close < cur.bbmiddle); }
function crossedUp(cur, prv) { return !!(cur && prv && cur.bbmiddle != null && prv.bbmiddle != null && prv.close <= prv.bbmiddle && cur.close > cur.bbmiddle); }

function v7Trace(A, prior, ctx = {}) {
  const cfg = ctx.cfg || {};
  const revFrac = cfg.reversalFrac != null ? cfg.reversalFrac : -0.15;
  const pausePts = cfg.pausePts != null ? cfg.pausePts : 8;
  const heldBull = ctx.heldBull != null ? ctx.heldBull : ctx.heldDir === 'bull';
  const heldBear = ctx.heldBear != null ? ctx.heldBear : ctx.heldDir === 'bear';
  const anyHeld = heldBull || heldBear;
  const isFifteen = ctx.isFifteen !== false;
  const out = { family: 'v7', stage: isFifteen ? '15m' : '5m', held: { bull: heldBull, bear: heldBear }, inputs: {}, triggers: [], fired: null };
  const c15 = A && A['15m'];
  if (!c15 || c15.bbmiddle == null || c15.close == null) { out.reason = 'no-15m'; return out; }
  const c5 = A['5m'], prior15 = prior && prior['15m'], p5c = prior && prior['5m'];
  const { close, low, high, bbmiddle: mid } = c15;
  const green = close >= (c15.open != null ? c15.open : close);
  const bw5 = (c5 && c5.bbupper != null && c5.bblower != null) ? (c5.bbupper - c5.bblower) : null;
  const trendTf = cfg.trendTf || '15m';
  const t5 = trendOf(c5), t15 = trendOf(c15), p5 = trendOf(p5c);
  let up, down;
  if (trendTf === '5m') { up = t5.up; down = t5.down; } else if (trendTf === 'both') { up = t5.up && t15.up; down = t5.down && t15.down; } else { up = t15.up; down = t15.down; }
  const higherHigh = !!(prior15 && prior15.high != null && high > prior15.high);
  const lowerLow = !!(prior15 && prior15.low != null && low < prior15.low);
  const bearRev = pat.bearishReversalCandle(c15, prior15), bullRev = pat.bullishReversalCandle(c15, prior15);
  const botNorm = bw5 > 0 ? (c5.bblower - low) / bw5 : null, topNorm = bw5 > 0 ? (high - c5.bbupper) / bw5 : null;
  const ext = conf.bandExtension(A);
  const pctOf = (o, tf) => (o[tf] && o[tf].pctOfOneWidth != null) ? o[tf].pctOfOneWidth / 100 : -Infinity;
  const upExt = Math.max(pctOf(ext.upper, '5m'), pctOf(ext.upper, '15m')), dnExt = Math.max(pctOf(ext.lower, '5m'), pctOf(ext.lower, '15m'));
  const widenFrac = cfg.widenFrac != null ? cfg.widenFrac : 0.10;
  out.inputs = {
    c15: { open: r2(c15.open), high: r2(high), low: r2(low), close: r2(close), mid: r2(mid), ema: r2(c15.ema), upper: r2(c15.bbupper), lower: r2(c15.bblower), green },
    c5: c5 ? { close: r2(c5.close), mid: r2(c5.bbmiddle), ema: r2(c5.ema), upper: r2(c5.bbupper), lower: r2(c5.bblower) } : null,
    c60: A['60m'] ? { close: r2(A['60m'].close), mid: r2(A['60m'].bbmiddle), upper: r2(A['60m'].bbupper), lower: r2(A['60m'].bblower) } : null,
    trend15: trendWord(t15), trend5: trendWord(t5), trendUsed: up ? 'up' : down ? 'down' : 'mixed', trendTf,
    higherHigh, lowerLow, bearishCandle: bearRev, bullishCandle: bullRev,
    wickPastLower5m: r2(botNorm), wickPastUpper5m: r2(topNorm), bandExtUp: Number.isFinite(upExt) ? r2(upExt) : null, bandExtDown: Number.isFinite(dnExt) ? r2(dnExt) : null,
  };
  const T = (o) => { out.triggers.push(o); return o; };
  const P = (name, ok, value) => ({ name, ok: !!ok, value: value == null ? undefined : value });

  if (!isFifteen) {
    // Between 15m closes v7 only covers / flips a HELD side, on a 2-bar-confirmed 5m turn. It never opens fresh.
    const en = cfg.fiveMin === true;
    const flip = cfg.fiveMinFlip !== false;
    T({ id: '5m-turn-bull', label: '5m turned down 2 bars (held bull)', side: (flip && t15.down) ? 'bear' : null, cover: 'bull', enabled: en,
      active: en && heldBull && t5.down && p5.down, parts: [P('holding a bull', heldBull), P('5m trend down', t5.down), P('prior 5m down', p5.down), P('15m down too → also flip to bear', t15.down)] });
    T({ id: '5m-turn-bear', label: '5m turned up 2 bars (held bear)', side: (flip && t15.up) ? 'bull' : null, cover: 'bear', enabled: en,
      active: en && heldBear && t5.up && p5.up, parts: [P('holding a bear', heldBear), P('5m trend up', t5.up), P('prior 5m up', p5.up), P('15m up too → also flip to bull', t15.up)] });
    out.note = 'between 15m closes: no fresh opens, only a 2-bar 5m turn against a held side';
  } else {
    const fc = cfg.fastCover5m, e5 = c5 && c5.ema;
    if (fc) {
      T({ id: 'fast-cover-bull', label: `fast cover (5m ${fc === 'trend' ? 'turned down' : 'lost 9EMA'})`, cover: 'bull', enabled: true,
        active: anyHeld && heldBull && (fc === 'trend' ? t5.down : (e5 != null && c5.close < e5)), parts: [P('holding a bull', heldBull)] });
      T({ id: 'fast-cover-bear', label: `fast cover (5m ${fc === 'trend' ? 'turned up' : 'reclaimed 9EMA'})`, cover: 'bear', enabled: true,
        active: anyHeld && heldBear && (fc === 'trend' ? t5.up : (e5 != null && c5.close > e5)), parts: [P('holding a bear', heldBear)] });
    }
    const flipMom = cfg.flipMomentum === true, tf = cfg.trendFlip !== false;
    T({ id: 'trend-flip-bear', label: 'trend flip → bear', side: 'bear', cover: 'bull', enabled: tf,
      active: tf && heldBull && down && (!flipMom || lowerLow), parts: [P('holding a bull', heldBull), P(`${trendTf} trend down (close & 9EMA below midline)`, down), ...(flipMom ? [P('lower low', lowerLow)] : [])] });
    T({ id: 'trend-flip-bull', label: 'trend flip → bull', side: 'bull', cover: 'bear', enabled: tf,
      active: tf && heldBear && up && (!flipMom || higherHigh), parts: [P('holding a bear', heldBear), P(`${trendTf} trend up (close & 9EMA above midline)`, up), ...(flipMom ? [P('higher high', higherHigh)] : [])] });
    // BE-WRONG
    const bwOn = !!cfg.beWrong, dirOk = cfg.beWrongDirMin == null || (ctx.directionality != null && ctx.directionality >= cfg.beWrongDirMin);
    const strong = cfg.beWrongStrong === true, c5mid = c5 && c5.bbmiddle;
    T({ id: 'be-wrong-bear', label: 'be wrong → bear (breaking lows + bearish candle)', side: 'bear', enabled: bwOn,
      active: bwOn && dirOk && heldBull && lowerLow && bearRev && (!strong || (c5mid != null && close < c5mid)),
      parts: [P('holding a bull', heldBull), P('15m broke the prior low', lowerLow), P('bearish reversal candle', bearRev), ...(cfg.beWrongDirMin != null ? [P('directional enough', dirOk, r2(ctx.directionality))] : [])] });
    T({ id: 'be-wrong-bull', label: 'be wrong → bull (breaking highs + bullish candle)', side: 'bull', enabled: bwOn,
      active: bwOn && dirOk && heldBear && higherHigh && bullRev && (!strong || (c5mid != null && close > c5mid)),
      parts: [P('holding a bear', heldBear), P('15m broke the prior high', higherHigh), P('bullish reversal candle', bullRev), ...(cfg.beWrongDirMin != null ? [P('directional enough', dirOk, r2(ctx.directionality))] : [])] });
    const clx = cfg.centerlineCross;
    if (clx) {
      const dn5 = crossedDown(c5, p5c), dn15 = crossedDown(c15, prior15), up5 = crossedUp(c5, p5c), up15 = crossedUp(c15, prior15);
      const bearX = clx === '5m' ? dn5 : clx === '15m' ? dn15 : clx === 'both' ? (dn5 && dn15) : (dn5 || dn15);
      const bullX = clx === '5m' ? up5 : clx === '15m' ? up15 : clx === 'both' ? (up5 && up15) : (up5 || up15);
      T({ id: 'be-wrong-cross-bear', label: `be wrong → bear (centerline cross ${clx})`, side: 'bear', enabled: bwOn, active: bwOn && dirOk && heldBull && bearX, parts: [P('holding a bull', heldBull), P('closed below the midline', bearX)] });
      T({ id: 'be-wrong-cross-bull', label: `be wrong → bull (centerline cross ${clx})`, side: 'bull', enabled: bwOn, active: bwOn && dirOk && heldBear && bullX, parts: [P('holding a bear', heldBear), P('closed above the midline', bullX)] });
    }
    // OVEREXTENSION
    const rtg = cfg.revTrendGate === true;
    T({ id: 'overext-bottom', label: 'overextension bottom → bull', side: 'bull', cover: heldBear ? 'bear' : null, enabled: bw5 > 0,
      active: bw5 > 0 && botNorm >= revFrac && close > c5.bblower && !(rtg && down),
      parts: [P(`15m wick reached the 5m lower band (≥ ${revFrac} of its width past it)`, botNorm != null && botNorm >= revFrac, r2(botNorm)), P('closed back above the 5m lower band', bw5 > 0 && close > c5.bblower)] });
    T({ id: 'overext-top', label: 'overextension top → bear', side: 'bear', cover: heldBull ? 'bull' : null, enabled: bw5 > 0,
      active: bw5 > 0 && topNorm >= revFrac && close < c5.bbupper && !(rtg && up),
      parts: [P(`15m wick reached the 5m upper band (≥ ${revFrac} of its width past it)`, topNorm != null && topNorm >= revFrac, r2(topNorm)), P('closed back below the 5m upper band', bw5 > 0 && close < c5.bbupper)] });
    // GRIND
    const gOn = widenFrac != null;
    T({ id: 'grind-top', label: 'grind top → bear', side: 'bear', cover: heldBull ? 'bull' : null, enabled: gOn,
      active: gOn && upExt >= widenFrac && close > mid && bearRev,
      parts: [P(`1m band pushed past the slower upper band (≥ ${widenFrac})`, upExt >= widenFrac, Number.isFinite(upExt) ? r2(upExt) : null), P('15m close above its midline', close > mid), P('bearish reversal candle', bearRev)] });
    T({ id: 'grind-bottom', label: 'grind bottom → bull', side: 'bull', cover: heldBear ? 'bear' : null, enabled: gOn,
      active: gOn && dnExt >= widenFrac && close < mid && bullRev,
      parts: [P(`1m band pushed past the slower lower band (≥ ${widenFrac})`, dnExt >= widenFrac, Number.isFinite(dnExt) ? r2(dnExt) : null), P('15m close below its midline', close < mid), P('bullish reversal candle', bullRev)] });
    // CANDLE AT CONFLUENCE
    const cc = cfg.candleConfluenceRadius;
    if (cc != null) {
      const res = close > mid && bearRev ? conf.strongestClusterNear(A, high, { radius: cc, minTf: 3 }) : null;
      const sup = close < mid && bullRev ? conf.strongestClusterNear(A, low, { radius: cc, minTf: 3 }) : null;
      T({ id: 'candle-top', label: 'reversal candle at resistance cluster → bear', side: 'bear', cover: heldBull ? 'bull' : null, enabled: true,
        active: !!(res && res.mid >= close), parts: [P('15m above midline', close > mid), P('bearish reversal candle', bearRev), P('strong cluster at the high', !!(res && res.mid >= close), res ? r2(res.mid) : null)] });
      T({ id: 'candle-bottom', label: 'reversal candle at support cluster → bull', side: 'bull', cover: heldBear ? 'bear' : null, enabled: true,
        active: !!(sup && sup.mid <= close), parts: [P('15m below midline', close < mid), P('bullish reversal candle', bullRev), P('strong cluster at the low', !!(sup && sup.mid <= close), sup ? r2(sup.mid) : null)] });
    }
    // ACTIVE COVER
    const ac = cfg.activeCoverRadius != null ? cfg.activeCoverRadius : 8;
    {
      const res = anyHeld && heldBull && close > mid ? conf.strongestClusterNear(A, close, { radius: ac, minTf: 3 }) : null;
      const sup = anyHeld && heldBear && close < mid ? conf.strongestClusterNear(A, close, { radius: ac, minTf: 3 }) : null;
      T({ id: 'active-cover-bull', label: 'held bull runs into resistance → cover', cover: 'bull', enabled: ac != null,
        active: ac != null && !!(res && res.mid > close && res.mid - close <= ac), parts: [P('holding a bull', heldBull), P('15m above midline', close > mid), P(`resistance cluster within ${ac} pts above`, !!(res && res.mid > close && res.mid - close <= ac), res ? r2(res.mid) : null)] });
      T({ id: 'active-cover-bear', label: 'held bear runs into support → cover', cover: 'bear', enabled: ac != null,
        active: ac != null && !!(sup && sup.mid < close && close - sup.mid <= ac), parts: [P('holding a bear', heldBear), P('15m below midline', close < mid), P(`support cluster within ${ac} pts below`, !!(sup && sup.mid < close && close - sup.mid <= ac), sup ? r2(sup.mid) : null)] });
    }
    // TREND CONTINUATION (with its gates)
    const og = cfg.openGate5m === true;
    const contGate = (side) => {
      if (pat.htfOverextended(A, side, cfg.htfGate)) return side === 'bull' ? 'htf-gate (60m above the upper band)' : 'htf-gate (60m below the lower band)';
      if (og && (side === 'bull' ? t5.down : t5.up)) return side === 'bull' ? 'open-veto (5m turned down)' : 'open-veto (5m turned up)';
      const cl = conf.strongestClusterNear(A, close, { radius: 25, minTf: 3 });
      if (side === 'bull' && cl && cl.mid > close && cl.mid - close <= pausePts) return `pause-into-resistance @${cl.mid}`;
      if (side === 'bear' && cl && cl.mid < close && close - cl.mid <= pausePts) return `pause-into-support @${cl.mid}`;
      return null;
    };
    {
      const cond = up && green && !heldBear, gate = cond ? contGate('bull') : null;
      T({ id: 'trend-cont-bull', label: 'trend continuation → bull', side: 'bull', enabled: true, active: cond, blockedBy: gate || undefined,
        parts: [P(`${trendTf} trend up`, up), P('green 15m candle', green), P('not holding a bear', !heldBear)] });
    }
    {
      const cond = down && !green && !heldBull, gate = cond ? contGate('bear') : null;
      T({ id: 'trend-cont-bear', label: 'trend continuation → bear', side: 'bear', enabled: true, active: cond, blockedBy: gate || undefined,
        parts: [P(`${trendTf} trend down`, down), P('red 15m candle', !green), P('not holding a bull', !heldBull)] });
    }
    if (cfg.breakOpen) {
      const bo = pat.breakOpen(c15, prior15, cfg.breakOpen, heldBull, heldBear);
      T({ id: 'break-open', label: `green breaks the high (${cfg.breakOpen})`, side: bo ? bo.openSide : null, enabled: true, active: !!bo, parts: [] });
    }
  }
  // FIRED = the first enabled, active trigger in priority order — v7Signal's own answer. A trend continuation
  // that is blocked by a gate still ENDS the evaluation (v7Signal returns there with no open), so it "fires" as
  // a hold with blockedBy set.
  const first = out.triggers.find((t) => t.enabled && t.active);
  out.fired = first ? first.id : null;
  out.reason = first ? (first.blockedBy || first.label) : (isFifteen ? 'neutral' : 'intra-5m hold');
  return out;
}

// The trace function for a variant's signal family, or null (only v7 is traced so far).
function traceFor(variant) { return /^v7-/.test(String(variant || '')) ? v7Trace : null; }

module.exports = { v7Trace, traceFor };
