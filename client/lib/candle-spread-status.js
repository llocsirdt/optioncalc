'use strict';
/**
 * Live candle-spread ENGINE STATUS badge. Polls the server status API and renders, near the version:
 *   - MODE (DEV / DISARMED / TEST-ARMED / LIVE-ARMED) — colour-coded, so you can confirm the arm state
 *     at a glance (and which gate is off if not armed).
 *   - a compact inline activity rollup for any ARMED (test/live) strategy.
 * Clicking the badge opens a GRID popover (rows = signal family v0-v9, columns = each sub-variant), one
 * cell per strategy with its execution summary (P&L + o/c/f, armed order counts) — the same shape as the
 * compare page, since a flat 60-row list is unreadable. Per-cell hover title carries the full detail.
 * Purpose: validate at a glance that the server is doing what we expect. Read-only.
 */
(function () {
  const POLL_MS = 12000;
  const apiBase = () => (typeof PROXY_URL !== 'undefined' ? PROXY_URL : 'http://localhost:3001');
  const el = () => document.getElementById('csEngineStatus');
  const money = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

  // Grid axes — MUST match the server variant naming (family-width[-suffix]) and the compare page.
  const FAMILIES = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'];
  const COLUMNS = [
    { k: '10', h: '$10' }, { k: '20', h: '$20' }, { k: '40', h: '$40' },
    { k: '20-cATM', h: '$20 ctr' }, { k: '40-cATM', h: '$40 ctr' },
    { k: '20-10k', h: '$20·10k' }, { k: '40-10k', h: '$40·10k' },
  ];

  function badgeColor(mode) {
    if (/LIVE-ARMED/.test(mode)) return '#c0392b';   // red — REAL orders
    if (/TEST-ARMED/.test(mode)) return '#e67e22';   // orange — paper orders hitting Schwab
    if (/DISARMED/.test(mode)) return '#7f8c8d';     // gray
    return '#95a5a6';                                // DEV / all dry-run
  }

  // Inject the grid CSS once (scoped to the popover id).
  function ensureGridStyle() {
    if (document.getElementById('csEngineStatusCss')) return;
    const st = document.createElement('style');
    st.id = 'csEngineStatusCss';
    st.textContent =
      '#csEngineStatusPop .cshdr{color:#ddd;font-size:11px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #444}'
      + '#csEngineStatusPop table.csg{border-collapse:separate;border-spacing:3px;font:10px ui-monospace,Menlo,monospace}'
      + '#csEngineStatusPop .csg th{color:#999;font-weight:600;padding:1px 3px;text-align:center;white-space:nowrap}'
      + '#csEngineStatusPop .csg th.rowh{text-align:right;color:#ccc}'
      + '#csEngineStatusPop .csg td.c{width:66px;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:4px;padding:2px 3px;text-align:center;vertical-align:top}'
      + '#csEngineStatusPop .csg td.e{background:transparent;border:0}'
      + '#csEngineStatusPop .csg td.armed{border-color:#e67e22;box-shadow:0 0 0 1px #e67e22}'
      + '#csEngineStatusPop .csg .pnl{font-weight:700}'
      + '#csEngineStatusPop .csg .sub{color:#888;font-size:9px}'
      + '#csEngineStatusPop .csg .ord{color:#e67e22;font-size:9px}'
      + '#csEngineStatusPop .csfoot{color:#888;font-size:10px;margin-top:6px}';
    document.head.appendChild(st);
  }

  let pop = null, lastHtml = '';
  function ensurePop() {
    if (pop) return pop;
    ensureGridStyle();
    pop = document.createElement('div');
    pop.id = 'csEngineStatusPop';
    pop.style.cssText = 'position:fixed;z-index:99999;display:none;max-width:min(96vw,820px);max-height:80vh;'
      + 'overflow:auto;background:#1e1e1e;color:#eee;border:1px solid #555;border-radius:6px;padding:10px 12px;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,0.45);';
    pop.addEventListener('click', e => e.stopPropagation());   // clicking inside the popover keeps it open
    document.body.appendChild(pop);
    return pop;
  }
  function hidePop() { if (pop) pop.style.display = 'none'; }
  function showPop(anchor) {
    const p = ensurePop();
    p.innerHTML = lastHtml || '<div class="cshdr">(no detail yet)</div>';
    p.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(r.left, window.innerWidth - p.offsetWidth - 6)) + 'px';
    p.style.top = Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 6) + 'px';
  }
  function togglePop(anchor) {
    if (pop && pop.style.display === 'block') hidePop(); else showPop(anchor);
  }

  // Full per-cell detail (native title on the cell) — the old one-line-per-strategy text.
  function cellTitle(r) {
    const ro = r.realOrders || {};
    const geo = `$${r.width}${r.shift ? '+' + r.shift : ''}`;
    const ord = r.mode !== 'simulate' ? ` · orders ${ro.sent || 0} sent/${ro.canceled || 0} cxl/${ro.filled || 0} fill${ro.lastAt ? ' @' + String(ro.lastAt).split(',').pop().trim() : ''}` : '';
    const pnl = r.terminalPnl != null ? `${money(r.terminalPnl)} (floor ${money(r.realizedPnl)})` : money(r.realizedPnl);
    const bt = (r.backtestAvg != null && r.vsBacktest != null)
      ? ` · vs bt ${r.vsBacktest >= 0 ? '+' : ''}${money(r.vsBacktest)} (avg ${money(r.backtestAvg)})` : '';
    return `${r.variant} [${r.mode}] ${r.signalSymbol}→${r.symbol} ${geo} · ${r.opens}o/${r.covers}c/${r.coverFills}f · pos ${r.positions}(${r.covered}cov) · ${pnl}${bt}${ord}`;
  }

  // Build the popover: header line + the family×sub-variant grid of execution summaries.
  function gridHtml(s, tickMin) {
    const g = s.gates || {};
    const hdr = `<div class="cshdr"><b>${s.mode}</b> · next tick ~${tickMin}m · ${s.tradeDate}`
      + `  ·  gates: prod=${g.isProd} armed=${g.liveArmed} client=${g.hasTradingClient} acct=${g.hasAccountHash}</div>`;
    const byVar = {};
    (s.runs || []).forEach(r => { byVar[r.variant] = r; });
    const esc = (t) => String(t).replace(/"/g, '&quot;');
    let body = '<table class="csg"><thead><tr><th class="rowh"></th>'
      + COLUMNS.map(c => `<th>${c.h}</th>`).join('') + '</tr></thead><tbody>';
    let shown = 0;
    for (const f of FAMILIES) {
      body += `<tr><th class="rowh">${f}</th>`;
      for (const c of COLUMNS) {
        const r = byVar[`${f}-${c.k}`];
        if (!r) { body += '<td class="e"></td>'; continue; }
        shown++;
        const pnl = r.terminalPnl != null ? r.terminalPnl : r.realizedPnl;
        const col = pnl > 0 ? '#26a69a' : pnl < 0 ? '#ef5350' : '#aaa';
        const armed = r.mode !== 'simulate';
        const ro = r.realOrders || {};
        body += `<td class="c${armed ? ' armed' : ''}" title="${esc(cellTitle(r))}">`
          + `<div class="pnl" style="color:${col}">${money(pnl)}</div>`
          + `<div class="sub">${r.opens}o/${r.covers}c/${r.coverFills}f</div>`
          + (armed ? `<div class="ord">⚡${ro.sent || 0}/${ro.canceled || 0}x/${ro.filled || 0}f</div>` : '')
          + '</td>';
      }
      body += '</tr>';
    }
    body += '</tbody></table>';
    const missing = (s.runs || []).length - shown;
    const foot = missing > 0 ? `<div class="csfoot">+ ${missing} run(s) not on the v0-v9 grid</div>` : '';
    return hdr + body + foot;
  }

  function render(s) {
    const c = el(); if (!c) return;
    const gatesOff = [];
    if (!s.gates.isProd) gatesOff.push('not-prod');
    if (!s.gates.liveArmed) gatesOff.push('CANDLE_SPREAD_LIVE off');
    if (!s.gates.hasTradingClient) gatesOff.push('no trading client');
    if (!s.gates.hasAccountHash) gatesOff.push('no accountHash');
    const armed = /LIVE-ARMED|TEST-ARMED/.test(s.mode);
    const active = (s.runs || []).filter(r => r.mode !== 'simulate');
    const tickMin = Math.max(0, Math.round((s.msToNextTick || 0) / 60000));

    // COMPACT inline line: badge + (armed) a short activity rollup + tick.
    let inline = '';
    if (active.length) {
      inline = active.map(r => {
        const ro = r.realOrders || {};
        return `${r.variant} ${r.opens}o/${r.covers}c · ord ${ro.sent || 0}/${ro.canceled || 0}cxl/${ro.filled || 0}f`;
      }).join(' | ');
    } else if (gatesOff.length && !armed) {
      inline = `gates off: ${gatesOff.join(', ')}`;
    }

    lastHtml = gridHtml(s, tickMin);   // full grid lives in the click popover
    c.title = `${s.mode} · next tick ~${tickMin}m · ${s.tradeDate} — click for the strategy grid`;

    c.innerHTML =
      `<span style="background:${badgeColor(s.mode)};color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif">${s.mode}</span>`
      + (inline ? `<span style="font:11px monospace;color:#999"> ${inline}</span>` : '')
      + `<span style="font:11px monospace;color:#bbb"> · ~${tickMin}m</span>`;

    // Keep an open popover in sync with the fresh data.
    if (pop && pop.style.display === 'block') pop.innerHTML = lastHtml;
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
      c.title = c.title || 'click for the strategy grid';
      c.addEventListener('click', (e) => { e.stopPropagation(); togglePop(c); });
    }
    document.addEventListener('click', hidePop);                 // click elsewhere closes it
    window.addEventListener('resize', hidePop);
  });
})();
