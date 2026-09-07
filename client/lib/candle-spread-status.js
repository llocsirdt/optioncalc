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
    { k: '10-unc', h: '$10 unc' }, { k: '20-unc', h: '$20 unc' }, { k: '40-unc', h: '$40 unc' },
    { k: '20-cATM', h: '$20 ctr' }, { k: '40-cATM', h: '$40 ctr' },
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
      + '#csEngineStatusPop .csfoot{color:#888;font-size:10px;margin-top:6px}'
      // PICKER MODE — the same grid, but every cell is a selectable strategy.
      + '#csEngineStatusPop.pick .csg td.c{cursor:pointer}'
      + '#csEngineStatusPop.pick .csg td.c:hover{background:#3a3a3a;border-color:#6ab0f3}'
      + '#csEngineStatusPop .csg td.sel{border-color:#6ab0f3;box-shadow:0 0 0 2px #6ab0f3}'
      + '#csEngineStatusPop .csg .vname{color:#bbb;font-size:9px}';
    document.head.appendChild(st);
  }

  let pop = null, lastHtml = '', lastStatus = null, pickMode = null;
  function ensurePop() {
    if (pop) return pop;
    ensureGridStyle();
    pop = document.createElement('div');
    pop.id = 'csEngineStatusPop';
    pop.style.cssText = 'position:fixed;z-index:99999;display:none;max-width:min(96vw,820px);max-height:80vh;'
      + 'overflow:auto;background:#1e1e1e;color:#eee;border:1px solid #555;border-radius:6px;padding:10px 12px;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,0.45);';
    pop.addEventListener('click', (e) => {
      e.stopPropagation();   // clicking inside the popover keeps it open
      if (!pickMode) return;
      const td = e.target.closest && e.target.closest('td[data-variant]');
      if (!td) return;
      const cb = pickMode.onPick;
      hidePop();                       // clears pick mode + styling
      if (cb) cb(td.dataset.variant);
    });
    document.body.appendChild(pop);
    return pop;
  }
  function hidePop() { if (pop) { pop.style.display = 'none'; pop.classList.remove('pick'); } pickMode = null; }
  function showPop(anchor) {
    const p = ensurePop();
    p.classList.remove('pick');   // the badge's own popover is read-only, never a picker
    pickMode = null;
    p.innerHTML = lastHtml || '<div class="cshdr">(no detail yet)</div>';
    p.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(r.left, window.innerWidth - p.offsetWidth - 6)) + 'px';
    p.style.top = Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 6) + 'px';
  }
  function togglePop(anchor) {
    if (pop && pop.style.display === 'block' && !pickMode) hidePop(); else showPop(anchor);
  }

  // STRATEGY PICKER — the same family × width grid the badge shows, but selectable. Used in place of the
  // positions-source dropdown so choosing a strategy also shows its live P&L / activity, which is the
  // context you actually pick on. onPick(variant) fires and the popover closes.
  function openStrategyPicker(anchor, selected, onPick) {
    const p = ensurePop();
    if (!lastStatus) { p.innerHTML = '<div class="cshdr">Engine status not loaded yet — try again in a moment.</div>'; }
    else p.innerHTML = gridHtml(lastStatus, 0, { pick: true, selected });
    pickMode = { onPick };
    p.classList.add('pick');
    p.style.display = 'block';   // (set after innerHTML so offsetWidth below is measured correctly)
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.max(6, Math.min(r.left, window.innerWidth - p.offsetWidth - 6)) + 'px';
    p.style.top = Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 6) + 'px';
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
  function gridHtml(s, tickMin, opts) {
    const o = opts || {};
    const g = s.gates || {};
    const hdr = o.pick
      ? `<div class="cshdr"><b>Pick a strategy</b> · click a cell to load its book · ${s.tradeDate} · <b>${s.mode}</b></div>`
      : `<div class="cshdr"><b>${s.mode}</b> · next tick ~${tickMin}m · ${s.tradeDate}`
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
        const name = `${f}-${c.k}`;
        const sel = o.pick && o.selected === name;
        body += `<td class="c${armed ? ' armed' : ''}${sel ? ' sel' : ''}"${o.pick ? ` data-variant="${name}"` : ''} title="${esc(cellTitle(r))}">`
          + (o.pick ? `<div class="vname">${name}</div>` : '')
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


  // ── TRADABILITY BANNER ───────────────────────────────────────────────────────────────────────────
  // The engine standing down looks EXACTLY like a quiet signal day from the outside: no orders, no
  // positions, everything green. That ambiguity is why a whole closed-market session (2026-09-07, Labor
  // Day) ran unnoticed on a frozen underlying. So when the gate trips, say so loudly and say WHY —
  // a fixed bar across the top of the page, not a subtle badge someone has to go looking for.
  // Self-injecting so any page that loads this script gets it with no markup of its own.
  let bannerEl = null;
  function bannerNode() {
    if (bannerEl && document.body.contains(bannerEl)) return bannerEl;
    bannerEl = document.createElement('div');
    bannerEl.id = 'tradabilityBanner';
    bannerEl.setAttribute('role', 'status');
    // z-index 100, not a maximal value: the banner must sit UNDER the page's own controls (the submit
    // button in index.html's top-right sat behind it at 99999). It is a full-width fixed bar, so
    // anything it overlaps it also blocks from being clicked.
    bannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100;display:none;'
      + 'padding:8px 14px;font:600 13px/1.35 system-ui,sans-serif;text-align:center;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.25);letter-spacing:.2px';
    document.body.insertBefore(bannerEl, document.body.firstChild);
    return bannerEl;
  }
  // Reasons the gate can give, in the operator's language. `bad` = something is wrong and orders would
  // have been attempted; the closed-market cases are NORMAL and must read as normal, or the banner
  // becomes noise every weekend and holiday and stops being believed.
  const GATE_COPY = {
    'chain-not-quoted': { t: 'MARKET NOT OPEN', tone: 'closed',
      why: 'the option chain is listed but carries no live quotes' },
    'no-chain':         { t: 'NO OPTION CHAIN', tone: 'closed',
      why: 'no chain returned for today\'s expiration' },
    'stale-price':      { t: 'STALE PRICE FEED', tone: 'bad',
      why: 'the underlying has not printed recently' },
    'no-underlying':    { t: 'NO UNDERLYING PRICE', tone: 'bad',
      why: 'the pricing instrument returned no value' },
    'not-checked-yet':  { t: 'ENGINE NOT YET TICKED', tone: 'info',
      why: 'no tick has run since startup' },
  };
  const TONES = {
    closed: ['#4a4f57', '#fff'],                       // normal + expected (holiday/weekend): calm, not alarming
    bad:    ['#b3261e', '#fff'],                       // something is actually wrong
    info:   ['#5b6470', '#fff'],
    stale:  ['#8a6d1f', '#fff'],
  };
  function renderBanner(s) {
    const b = bannerNode();
    const t = s && s.tradability;
    // Only speak when the engine is NOT trading. A tradable market needs no announcement.
    if (!t || (t.ok !== false && t.reason !== 'not-checked-yet')) { b.style.display = 'none'; document.body.style.paddingTop = ''; return; }
    const copy = GATE_COPY[t.reason] || { t: 'NOT TRADING', tone: 'bad', why: t.detail || t.reason };
    const tone = t.stale && t.reason !== 'not-checked-yet' ? 'stale' : copy.tone;
    const when = t.mark ? ` &middot; last checked ${t.mark}` : '';
    const staleNote = t.stale && t.reason !== 'not-checked-yet'
      ? ' — and this check is itself stale, so the engine may not be ticking at all' : '';
    // Set the tone properties directly. Patching cssText with a regex silently did nothing, because the
    // base style declares no background/color to replace — the banner rendered as dark-on-white.
    const [bg, fg] = TONES[tone];
    b.style.background = bg;
    b.style.color = fg;
    b.innerHTML = `<b>${copy.t}</b> &mdash; engine is not placing orders: `
      + `${copy.why}${staleNote}<span style="opacity:.7;font-weight:400">${when}</span>`;
    b.style.display = 'block';
    // Push the page down so the bar never covers content.
    document.body.style.paddingTop = b.offsetHeight + 'px';
  }

  function render(s) {
    const c = el(); if (!c) return;   // inline badge only; the banner is rendered separately in poll()
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

    lastStatus = s;
    lastHtml = gridHtml(s, tickMin);   // full grid lives in the click popover
    c.title = `${s.mode} · next tick ~${tickMin}m · ${s.tradeDate} — click for the strategy grid`;

    // The inline badge carries it as well, so it is visible even when the page is scrolled or the
    // banner has been pushed off by another fixed element.
    const blocked = s.tradability && s.tradability.ok === false;
    c.innerHTML =
      (blocked ? `<span style="background:#b3261e;color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif;margin-right:4px">NOT TRADING</span>` : '')
      + `<span style="background:${badgeColor(s.mode)};color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif">${s.mode}</span>`
      + (inline ? `<span style="font:11px monospace;color:#999"> ${inline}</span>` : '')
      + `<span style="font:11px monospace;color:#bbb"> · ~${tickMin}m</span>`;

    // Keep an open popover in sync with the fresh data.
    if (pop && pop.style.display === 'block') pop.innerHTML = lastHtml;
  }

  async function poll() {
    // NOTE: the inline badge element is OPTIONAL. compare.html loads this script for the tradability
    // banner alone and has no #csEngineStatus, so bailing out here would silently disable the banner on
    // exactly the page where an operator is comparing live runs against the backtest.
    const c = el();
    try {
      const r = await fetch(`${apiBase()}/api/v1/candle-spread/status`, { cache: 'no-store' });
      if (r.ok) { const s = await r.json(); renderBanner(s); render(s); }
      else if (c) c.innerHTML = `<span style="font:11px monospace;color:#c0392b">engine status ${r.status}</span>`;
    } catch (e) {
      if (c) c.innerHTML = `<span style="font:11px monospace;color:#999">engine status: offline</span>`;
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

  // Exposed so the positions-source bar can use the SAME grid as a strategy picker instead of a dropdown.
  window.CandleSpreadStatus = { openStrategyPicker, hasStatus: () => !!lastStatus };
})();
