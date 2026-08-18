#!/usr/bin/env node
/**
 * Render a candle-spread run log as a readable timeline table.
 *
 * Usage:
 *   node scripts/analyze-candle-spread-run.js <SYMBOL> <EXPIRATION> [YYYY-MM-DD] [--local]
 * Examples:
 *   node scripts/analyze-candle-spread-run.js NDX 2026-08-17
 *   node scripts/analyze-candle-spread-run.js NDX 2026-08-17 2026-08-17 --local
 *
 * Defaults to the deployed server (CloudFront); --local hits localhost:3001.
 */
const PROD = 'https://d1kbxyxn33vpw2.cloudfront.net';
const LOCAL = 'http://localhost:3001';

const args = process.argv.slice(2);
const local = args.includes('--local');
const rest = args.filter(a => a !== '--local');
const [symbol, expiration, dateArg] = rest;
if (!symbol || !expiration) {
  console.error('Usage: node scripts/analyze-candle-spread-run.js <SYMBOL> <EXPIRATION> [YYYY-MM-DD] [--local]');
  process.exit(1);
}
const date = dateArg || expiration; // 0DTE: tradeDate == expiration
const base = local ? LOCAL : PROD;
const url = `${base}/api/v1/candle-spread/runs/${symbol}/${expiration}?date=${date}`;

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

(async () => {
  let j;
  try {
    const res = await fetch(url);
    j = await res.json();
  } catch (e) { console.error('fetch failed:', e.message, '\nurl:', url); process.exit(1); }
  if (!j || j.error) { console.error('run not found / error:', JSON.stringify(j), '\nurl:', url); process.exit(1); }

  const cc = (j.events || []).filter(e => e.type === 'candle_close');
  console.log(`RUN  ${j.config.symbol} ${j.config.expiration} (0DTE)  |  width $${j.config.spreadWidth}, incr ${j.config.strikeIncrement}, qty ${j.config.quantity}, cover=${j.config.coverStyle}/${j.config.coverTiming}, dryRun=${j.config.dryRun}`);
  if (!cc.length) { console.log('(no candle_close events yet)'); return; }
  console.log(`first action ~${closeTime(cc[0].candle.time)} ET · last ~${closeTime(cc[cc.length - 1].candle.time)} ET · ${cc.length} candles\n`);

  console.log(`${pad('TIME', 6)}${pad('CLOSE', 9)}${pad('CAND', 6)}${pad('ACTION', 7)}${pad('SPREAD (strikes)', 22)}${pad('LIMIT', 8)}${pad('LOCK', 8)}${pad('DIR', 6)}RUN P/L`);
  console.log('-'.repeat(84));

  for (const e of cc) {
    const t = closeTime(e.candle.time);
    const close = Number(e.candle.close).toFixed(0);
    const col = e.classification.simpleDir === 'bull' ? 'green' : e.classification.simpleDir === 'bear' ? 'red' : 'flat';
    const rows = [];
    for (const d of e.decisions) {
      if (d.action === 'open')  rows.push(['OPEN', spreadStr(d.legs), `$${d.limit}`, '']);
      else if (d.action === 'cover') rows.push(['COVER', spreadStr(d.legs), `$${d.limit}`, money(d.lockedFloor)]);
      else if (d.action === 'cancel-open') rows.push(['CANCEL', 'unfilled open', '', '']);
      else if (d.action === 'open-skip-conflict') rows.push(['HOLD', `counter-signal (${d.side}), trend intact`, '', '']);
      else if (d.action === 'open-skip') rows.push(['SKIP', `open ${d.side}: ${d.error || ''}`, '', '']);
      else if (d.action === 'neutral') rows.push(['—', 'no trade (neutral)', '', '']);
      else rows.push([d.action, '', '', '']);
    }
    // Why the cover fired (or why we held through an opposite candle), from coverContext.
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
      console.log(`${pad(head, 6)}${pad(close2, 9)}${pad(cand2, 6)}${pad(r[0], 7)}${pad(r[1], 22)}${pad(r[2], 8)}${pad(r[3], 8)}${pad(dir, 6)}${pad(pl, 8)}${last ? why : ''}`);
    });
  }

  const opens = cc.reduce((n, e) => n + e.decisions.filter(d => d.action === 'open').length, 0);
  const covers = cc.reduce((n, e) => n + e.decisions.filter(d => d.action === 'cover').length, 0);
  const openPos = (j.state.positions || []).filter(p => p.filled && !p.covered);
  console.log('-'.repeat(84));
  console.log(`SUMMARY  ${opens} opens · ${covers} covers · final dir: ${j.state.direction} · locked/realized P/L: ${money(j.state.realizedPnl)}`);
  console.log(`still open (uncovered): ${openPos.length}${openPos.length ? ' -> ' + openPos.map(p => spreadStr(p.legs)).join(', ') : ''}`);
})();
