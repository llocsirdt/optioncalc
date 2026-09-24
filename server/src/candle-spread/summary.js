'use strict';
/**
 * Concise end-of-day summary for a candle-spread run. Produces a compact, chronological list of
 * every order the strategy touched — time, action, side, strikes, price, and status/fill — plus
 * day totals, so a day can be reviewed at a glance without scrolling the full event JSON.
 *
 * Built purely from the run record (events + state.liveOrders), so it works identically in
 * dry-run (assumed fills) and live (real Schwab orders). The `orders` rows come from the
 * strategy's DECISIONS (what it intended); when real orders exist, a `live` section reports what
 * actually happened at the broker (sent / filled / canceled), which may differ in test mode.
 */

function money(n) {
  if (n == null || Number.isNaN(n)) return '';
  return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
}
function px(n) { return n == null ? '' : Number(n).toFixed(2); }

// Compact strike string for a vertical's legs: "C 21980/22000" (type + the two strikes low→high).
// Falls back to explicit side/type/strike tokens if the legs mix option types (shouldn't for a vertical).
function fmtLegs(legs) {
  if (!legs || !legs.length) return '';
  const type = legs[0].type;
  if (legs.some(l => l.type !== type)) return legs.map(l => `${l.side[0]}${l.type}${l.strike}`).join('/');
  const strikes = legs.map(l => l.strike).sort((a, b) => a - b);
  return `${type} ${strikes.join('/')}`;
}

// One-line label for a placed/simulated order, used for live console logging at placement time.
// e.g. "OPEN bull  C 21980/22000  @8.05  [SIM(dryRun)]"
function orderLine(meta, payload, tag) {
  const action = (meta.kind || 'order').toUpperCase();
  const side = meta.side ? ` ${meta.side}` : '';
  const legs = fmtLegs(meta.legs);
  const price = payload && payload.price != null ? `@${px(payload.price)}` : '';
  const net = payload && payload.orderType === 'NET_CREDIT' ? ' CR' : '';
  return `${action}${side}  ${legs}  ${price}${net}${tag ? `  [${tag}]` : ''}`.replace(/\s+/g, ' ').trim();
}

// Walk the run's candle_close decisions into ordered summary rows (the INTENDED strategy actions).
function collectDecisionRows(record) {
  const rows = [];
  for (const ev of record.events || []) {
    if (ev.type !== 'candle_close') continue;
    const t = (ev.candle && ev.candle.time) || ev.time;
    for (const d of ev.decisions || []) {
      switch (d.action) {
        case 'open':
          // NET, AND THE PRICE THAT WAS ACTUALLY ASKED. `d.limit` is the DEBIT-CANONICAL price; when
          // capital recapture sends the credit twin, the order at the broker is a different instrument at
          // a different number, and this row showed neither — so the day summary read as an all-debit
          // session and its prices could not be matched against the broker's order list. The live rows
          // have always carried `net`; the intended-strategy rows did not.
          rows.push({ time: t, action: 'OPEN', side: d.side, strikes: fmtLegs(d.legs), price: d.limit,
            net: d.sentNet === 'CREDIT' ? 'CR' : 'DB',
            sent: d.sentNet === 'CREDIT' && d.sentLimit != null ? d.sentLimit : null,
            note: d.filled ? 'filled' : 'working' });
          break;
        // A REFUSED ORDER IS PART OF THE DAY. These were all swept into the `default` and omitted, so a
        // session where the broker rejected an open, or leg-uniqueness blocked one, or the lock could not
        // be sent, summarised identically to one where everything went out cleanly.
        case 'open-not-sent':
          rows.push({ time: t, action: 'OPEN-X', side: d.side, strikes: fmtLegs(d.legs), price: d.limit,
            net: d.net === 'CREDIT' ? 'CR' : 'DB', note: `NOT SENT: ${d.reason || 'send failed'}` });
          break;
        case 'cover-not-sent':
          rows.push({ time: t, action: 'COVER-X', side: '', strikes: '', price: d.target,
            note: `NOT SENT: ${d.reason || 'send failed'}` });
          break;
        case 'combo-lock-open':
          rows.push({ time: t, action: 'COMBO', side: '', strikes: `${d.legs} legs`, price: d.limit,
            net: d.net === 'CREDIT' ? 'CR' : 'DB',
            note: `lock ${d.winner} + open ${d.openId}, floor ${money(d.lockedFloor)}` });
          break;
        // HEDGES. offsets, wings and flies are real orders that spend real money — up to the $1,500 daily
        // fly budget alone — and none of them appeared in this summary at all.
        case 'floor-offset':
        case 'wing':
        case 'fly':
          rows.push({ time: t, action: d.action.toUpperCase().replace('FLOOR-', ''), side: '',
            strikes: fmtLegs(d.legs), price: d.limit != null ? d.limit : null,
            note: `${d.tag || ''} cost ${money(d.cost)}${d.ratio != null ? ` (${d.ratio}:1)` : ''}`.trim() });
          break;
        case 'offset-fill':
        case 'wing-fill':
        case 'fly-fill':
          rows.push({ time: t, action: d.action.toUpperCase(), side: '', strikes: fmtLegs(d.legs),
            price: d.fillPrice, note: `cost ${money(d.cost)}` });
          break;
        case 'offset-expire':
        case 'wing-expire':
        case 'fly-expire':
          rows.push({ time: t, action: d.action.toUpperCase(), side: '', strikes: fmtLegs(d.legs),
            price: d.limit, note: 'expired unfilled' });
          break;
        case 'cover':
          rows.push({ time: t, action: 'COVER', side: d.side || '', strikes: fmtLegs(d.legs), price: d.limit, note: d.geometry || '' });
          break;
        case 'cover-rest':
          rows.push({ time: t, action: 'COVER-REST', side: '', strikes: fmtLegs(d.legs), price: d.target, note: `resting@target ${d.geometry || ''}`.trim() });
          break;
        case 'cover-fill':
          rows.push({ time: t, action: 'COVER-FILL', side: '', strikes: '', price: d.fillPrice, note: `floor ${money(d.lockedFloor)}` });
          break;
        case 'cancel-open':
          rows.push({ time: t, action: 'CANCEL', side: '', strikes: '', price: null, note: d.reason || 'unfilled' });
          break;
        default: break; // open-skip / conflict / neutral are non-orders — omitted from the concise view
      }
    }
  }
  return rows;
}

// Real broker orders (only present when live/test sends happened).
function collectLiveRows(record) {
  const los = (record.state && record.state.liveOrders) || [];
  return los.map(o => ({
    time: o.placedAtEST || (o.placedAt ? new Date(o.placedAt).toISOString() : ''),
    action: (o.kind || 'order').toUpperCase(),
    strikes: fmtLegs(o.legs),
    sent: o.sentPrice, requested: o.requestedPrice,
    net: o.net === 'NET_CREDIT' ? 'CR' : 'DB',
    testMode: !!o.testMode,
    status: o.status,
    fillPrice: o.fillPrice != null ? o.fillPrice : null,
    orderId: o.orderId
  }));
}

// Day totals from the EOD settlement event (if present) plus open/cover counts.
function collectTotals(record) {
  const eod = [...(record.events || [])].reverse().find(e => e.type === 'eod_settlement');
  const rows = collectDecisionRows(record);
  return {
    opens: rows.filter(r => r.action === 'OPEN').length,
    creditOpens: rows.filter(r => r.action === 'OPEN' && r.net === 'CR').length,
    covers: rows.filter(r => r.action === 'COVER' || r.action === 'COVER-REST').length,
    coverFills: rows.filter(r => r.action === 'COVER-FILL').length,
    cancels: rows.filter(r => r.action === 'CANCEL').length,
    // Counted, because "nothing was refused today" and "refusals were never in this view" looked the same.
    notSent: rows.filter(r => r.action === 'OPEN-X' || r.action === 'COVER-X').length,
    hedges: rows.filter(r => ['OFFSET', 'WING', 'FLY'].includes(r.action)).length,
    hedgeFills: rows.filter(r => ['OFFSET-FILL', 'WING-FILL', 'FLY-FILL'].includes(r.action)).length,
    combos: rows.filter(r => r.action === 'COMBO').length,
    settle: eod ? eod.settle : null,
    terminalPnl: eod ? eod.terminalPnl : null,
    floorPnl: eod ? eod.floorPnl : (record.state ? record.state.realizedPnl : null)
  };
}

function buildDaySummary(record) {
  return {
    runId: record.runId,
    tradeDate: record.tradeDate,
    variant: record.config && (record.config.variantLabel || record.config.variant),
    symbol: record.config && record.config.symbol,
    orders: collectDecisionRows(record),
    live: collectLiveRows(record),
    totals: collectTotals(record)
  };
}

// Render the summary as a compact fixed-width text block for the server log.
function renderText(s) {
  const L = [];
  L.push(`── ${s.runId}  (${s.variant || 'run'})  ${s.symbol || ''} ──`);
  const T = s.totals;
  L.push(`opens:${T.opens}  covers:${T.covers}  coverFills:${T.coverFills}  cancels:${T.cancels}`
    + `  settle:${T.settle != null ? px(T.settle) : '—'}  floor:${money(T.floorPnl)}  terminal:${money(T.terminalPnl)}`);
  if (!s.orders.length) { L.push('  (no orders)'); }
  else {
    L.push('  TIME'.padEnd(16) + 'ACTION'.padEnd(12) + 'SIDE'.padEnd(6) + 'STRIKES'.padEnd(16) + 'PRICE'.padEnd(8) + 'NOTE');
    for (const r of s.orders) {
      L.push('  ' + String(r.time || '').padEnd(14) + String(r.action).padEnd(12) + String(r.side || '').padEnd(6)
        + String(r.strikes || '').padEnd(16) + String(r.price != null ? px(r.price) : '').padEnd(8) + String(r.note || ''));
    }
  }
  if (s.live && s.live.length) {
    L.push('  — real broker orders —');
    L.push('  ' + 'ACTION'.padEnd(12) + 'STRIKES'.padEnd(16) + 'SENT'.padEnd(8) + 'NET'.padEnd(4) + 'MODE'.padEnd(6) + 'STATUS'.padEnd(10) + 'FILL');
    for (const o of s.live) {
      L.push('  ' + String(o.action).padEnd(12) + String(o.strikes || '').padEnd(16) + String(px(o.sent)).padEnd(8)
        + String(o.net).padEnd(4) + (o.testMode ? 'TEST' : 'LIVE').padEnd(6) + String(o.status || '').padEnd(10)
        + (o.fillPrice != null ? px(o.fillPrice) : ''));
    }
  }
  return L.join('\n');
}

module.exports = { buildDaySummary, renderText, fmtLegs, orderLine, money };
