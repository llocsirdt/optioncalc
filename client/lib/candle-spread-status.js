'use strict';
/**
 * Live candle-spread ENGINE STATUS badge. Polls the server status API and renders, near the version:
 *   - MODE (DEV / DISARMED / TEST-ARMED / LIVE-ARMED) — colour-coded, so you can confirm the arm state
 *     at a glance (and which gate is off if not armed).
 *   - per-strategy activity today (opens/covers/fills, positions, realized P/L) and, for test/live runs,
 *     the real-order counts (sent / canceled / filled) + last order time.
 * Purpose: validate that the server is actually doing what we expect — especially the prod test-mode
 * session (v6 sending unfillable paper orders that get canceled ~60s later). Read-only.
 */
(function () {
  const POLL_MS = 12000;
  const apiBase = () => (typeof PROXY_URL !== 'undefined' ? PROXY_URL : 'http://localhost:3001');
  const el = () => document.getElementById('csEngineStatus');
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');

  function badgeColor(mode) {
    if (/LIVE-ARMED/.test(mode)) return '#c0392b';   // red — REAL orders
    if (/TEST-ARMED/.test(mode)) return '#e67e22';   // orange — paper orders hitting Schwab
    if (/DISARMED/.test(mode)) return '#7f8c8d';     // gray
    return '#95a5a6';                                // DEV / all dry-run
  }

  function render(s) {
    const c = el(); if (!c) return;
    const gatesOff = [];
    if (!s.gates.isProd) gatesOff.push('not-prod');
    if (!s.gates.liveArmed) gatesOff.push('CANDLE_SPREAD_LIVE off');
    if (!s.gates.hasTradingClient) gatesOff.push('no trading client');
    if (!s.gates.hasAccountHash) gatesOff.push('no accountHash');
    const armed = /LIVE-ARMED|TEST-ARMED/.test(s.mode);
    const active = s.runs.filter(r => r.mode !== 'simulate');
    const shown = active.length ? active : s.runs;
    const rows = shown.map(r => {
      const ro = r.realOrders || {};
      const orderStr = (r.mode !== 'simulate')
        ? ` · orders ${ro.sent || 0} sent/${ro.canceled || 0} cxl/${ro.filled || 0} fill${ro.lastAt ? ' @' + String(ro.lastAt).split(',').pop().trim() : ''}`
        : '';
      const geo = `$${r.width}${r.shift ? '+' + r.shift : ''}`;
      return `<div style="font:11px monospace;color:#444">`
        + `${r.variant} [${r.mode}] ${r.signalSymbol}→${r.symbol} ${geo} · `
        + `${r.opens}o/${r.covers}c/${r.coverFills}f · pos ${r.positions}(${r.covered}cov) · ${money(r.realizedPnl)}${orderStr}</div>`;
    }).join('');
    const tickMin = Math.max(0, Math.round((s.msToNextTick || 0) / 60000));
    c.innerHTML =
      `<span style="background:${badgeColor(s.mode)};color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif">${s.mode}</span>`
      + (gatesOff.length && !armed ? `<span style="font:11px monospace;color:#999"> gates off: ${gatesOff.join(', ')}</span>` : '')
      + `<span style="font:11px monospace;color:#999"> · next tick ~${tickMin}m · ${s.tradeDate}</span>`
      + rows;
  }

  async function poll() {
    const c = el(); if (!c) return;
    try {
      const r = await fetch(`${apiBase()}/api/v1/candle-spread/status`, { cache: 'no-store' });
      if (r.ok) render(await r.json());
      else c.innerHTML = `<span style="font:11px monospace;color:#c0392b">engine status ${r.status}</span>`;
    } catch (e) {
      c.innerHTML = `<span style="font:11px monospace;color:#999">engine status: offline</span>`;
    }
  }

  window.addEventListener('DOMContentLoaded', () => { poll(); setInterval(poll, POLL_MS); });
})();
