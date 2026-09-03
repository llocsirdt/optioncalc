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

  // Touch fallback for the hover tooltip: tapping the badge toggles a popover with the SAME detail text
  // (c.title), since :hover/title tooltips don't appear on phones/touch devices.
  let pop = null;
  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'csEngineStatusPop';
    pop.style.cssText = 'position:fixed;z-index:99999;display:none;max-width:min(94vw,680px);max-height:70vh;'
      + 'overflow:auto;background:#1e1e1e;color:#eee;border:1px solid #555;border-radius:6px;padding:10px 12px;'
      + 'font:11px/1.5 monospace;white-space:pre-wrap;box-shadow:0 4px 18px rgba(0,0,0,0.45);';
    pop.addEventListener('click', e => e.stopPropagation());   // tapping the popover keeps it open
    document.body.appendChild(pop);
    return pop;
  }
  function hidePop() { if (pop) pop.style.display = 'none'; }
  function showPop(anchor) {
    const p = ensurePop();
    p.textContent = anchor.title || '(no detail yet)';
    p.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(r.left, window.innerWidth - p.offsetWidth - 6)) + 'px';
    p.style.top = Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 6) + 'px';
  }
  function togglePop(anchor) {
    if (pop && pop.style.display === 'block') hidePop(); else showPop(anchor);
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
    const tickMin = Math.max(0, Math.round((s.msToNextTick || 0) / 60000));

    // COMPACT inline line: badge + (armed) a short activity rollup + tick. Full per-strategy detail
    // lives in the hover tooltip so it never adds height to the header.
    let inline = '';
    if (active.length) {
      inline = active.map(r => {
        const ro = r.realOrders || {};
        return `${r.variant} ${r.opens}o/${r.covers}c · ord ${ro.sent || 0}/${ro.canceled || 0}cxl/${ro.filled || 0}f`;
      }).join(' | ');
    } else if (gatesOff.length && !armed) {
      inline = `gates off: ${gatesOff.join(', ')}`;
    }

    // tooltip = full detail
    const detail = s.runs.map(r => {
      const ro = r.realOrders || {};
      const geo = `$${r.width}${r.shift ? '+' + r.shift : ''}`;
      const ord = r.mode !== 'simulate' ? ` · orders ${ro.sent || 0} sent/${ro.canceled || 0} cxl/${ro.filled || 0} fill${ro.lastAt ? ' @' + String(ro.lastAt).split(',').pop().trim() : ''}` : '';
      // P&L = terminal (mark-to-market, the real number); floor shown in parens as the conservative lower bound.
      const pnl = r.terminalPnl != null ? `${money(r.terminalPnl)} (floor ${money(r.realizedPnl)})` : money(r.realizedPnl);
      // vs BACKTEST: how today's terminal compares to this variant's backtested avg daily P&L.
      const bt = (r.backtestAvg != null && r.vsBacktest != null)
        ? ` · vs bt ${r.vsBacktest >= 0 ? '+' : ''}${money(r.vsBacktest)} (avg ${money(r.backtestAvg)})` : '';
      // Two lines: (1) strategy + geometry + o/c/f + position counts; (2) INDENTED money stats (P&L, vs
      // backtest, real orders) — the run-on single line wrapped awkwardly and was hard to read.
      const head = `${r.variant} [${r.mode}] ${r.signalSymbol}→${r.symbol} ${geo} · ${r.opens}o/${r.covers}c/${r.coverFills}f · pos ${r.positions}(${r.covered}cov)`;
      return `${head}\n      ${pnl}${bt}${ord}`;
    }).join('\n');
    c.title = `${s.mode}   (next tick ~${tickMin}m · ${s.tradeDate})\ngates: prod=${s.gates.isProd} armed=${s.gates.liveArmed} client=${s.gates.hasTradingClient} acct=${s.gates.hasAccountHash}\n\n${detail}`;

    c.innerHTML =
      `<span style="background:${badgeColor(s.mode)};color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif">${s.mode}</span>`
      + (inline ? `<span style="font:11px monospace;color:#999"> ${inline}</span>` : '')
      + `<span style="font:11px monospace;color:#bbb"> · ~${tickMin}m</span>`;

    // If the tap-popover is open, keep it in sync with the fresh detail.
    if (pop && pop.style.display === 'block') pop.textContent = c.title;
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

  window.addEventListener('DOMContentLoaded', () => {
    poll();
    setInterval(poll, POLL_MS);
    const c = el();
    if (c) {
      c.style.cursor = 'pointer';
      c.title = c.title || 'tap for strategy detail';
      c.addEventListener('click', (e) => { e.stopPropagation(); togglePop(c); });
    }
    document.addEventListener('click', hidePop);                 // tap elsewhere closes it
    window.addEventListener('resize', hidePop);
  });
})();
