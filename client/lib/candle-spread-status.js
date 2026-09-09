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
  // SPLIT ROUTING, matching compare.html. LIVE RUN state comes from PROD even when developing locally:
  // the local engine only records while this machine is awake, so its runs stop at whatever ragged time
  // the Mac slept. On 2026-09-08 local held ~1 position per variant and no settlement event, so the grid
  // fell back to marking a near-empty book and showed three different strategies all at $305 — which reads
  // as "the values are wrong" rather than "you are looking at the wrong server".
  // ?proxy=local forces the local engine when that is genuinely what you want to inspect.
  const PROD_BASE = 'https://d1kbxyxn33vpw2.cloudfront.net';
  const _forced = new URLSearchParams(location.search).get('proxy');
  const apiBase = () => _forced === 'local'
    ? 'http://localhost:3001'
    : (_forced === 'remote' ? PROD_BASE
      : (typeof PROXY_URL !== 'undefined' && /^https?:\/\/(?!localhost|127\.)/.test(PROXY_URL) ? PROXY_URL : PROD_BASE));
  const el = () => document.getElementById('csEngineStatus');
  // OPTIONAL second host. When a page provides #csEngineInline the activity rollup and tick countdown
  // render there instead of trailing the badge, so the two can sit on separate lines and the header
  // stops wrapping raggedly on a narrow screen. Pages without it (compare.html) are unaffected.
  const inlineEl = () => document.getElementById('csEngineInline');
  const money = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

  // Grid axes — MUST match the server variant naming (family-width[-suffix]) and the compare page.
  const FAMILIES = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'];
  // The `-unc` twins are DROPPED from this grid entirely. They exist to measure what the day-loss
  // governor costs, are uncapped and therefore not candidates to trade, and at 30 of 80 runs they were
  // half the width of the grid — pure distraction on the screen used to watch the live session.
  // They remain fully available on the compare page behind its own toggle.
  const COLUMNS = [
    { k: '10', h: '$10' }, { k: '20', h: '$20' }, { k: '40', h: '$40' },
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
      // WATCHLIST diamond vs SETUP triangle, deliberately different marks and colours. The diamond is a
      // standing choice (amber, quiet); the triangle is a condition true only today (lime, louder). Lime
      // is reserved for the setup so it never reads as "armed" — armed is the orange the mode badge uses.
      + '#csEngineStatusPop .wl{color:#e2a33c;margin-left:3px;font-size:9px;cursor:help}'
      // A 9px diamond was doing all the work of marking six cells out of eighty. Lift the cell ground
      // as well, so the watched set reads as a GROUP at a glance rather than needing to be hunted for.
      // TWO class selectors (td.c.wlc), not one: `td.c` sets its own background further down this same
      // stylesheet, and at equal specificity the later rule wins — so a single-class `td.wlc` silently
      // lost and the lift never rendered. Also given real contrast against #2a2a2a; the first attempt
      // was four points of lightness, which is invisible on a phone in daylight.
      + '#csEngineStatusPop .csg td.c.wlc{background:#3b4351;border-color:#55606f}'
      + '#csEngineStatusPop .fav{color:#a3e635;margin-left:2px;font-size:9px;cursor:help}'
      + '#csEngineStatusPop .csg td.fav{box-shadow:inset 0 0 0 1px #a3e635}'
      + '#csEngineStatusPop .mk{text-align:right;line-height:1;height:9px}'
      + '#csEngineStatusPop .cssetup{color:#a3e635;font-size:11px;margin:0 0 5px;padding:3px 5px;'
      + 'border:1px solid #4d6b1a;border-radius:3px;background:#1e2a10;cursor:help}'
      + '#csEngineStatusPop .cssetup .n{color:#8a9b6a;font-weight:400}'
      // WATCH tier: hollow mark, muted slate, no cell glow. Present enough to notice, quiet enough that
      // it never competes with a tested setup.
      + '#csEngineStatusPop .favw{color:#7c8794;margin-left:2px;font-size:9px;cursor:help}'
      + '#csEngineStatusPop .csg td.favw{box-shadow:inset 0 0 0 1px #4a525c}'
      + '#csEngineStatusPop .cssetup.watch{color:#9aa4b0;border-color:#3a424c;background:#191d22}'
      + '#csEngineStatusPop .cssetup.watch .n{color:#6c7682}'
      + '#csEngineStatusPop .cssetup .row{font-size:10px;margin-top:2px;font-weight:400}'
      + '#csEngineStatusPop .cssetup .row.dim{color:#7f8b74}'
      + '#csEngineStatusPop .cssetup.watch .row.dim{color:#6c7682}'
      + '#csEngineStatusPop .avo{color:#c98b8b;margin-left:2px;font-size:9px;cursor:help}'
      + '#csEngineStatusPop .csg td.avo{box-shadow:inset 0 0 0 1px #6b3a3a}'
      + '#csEngineStatusPop .lift{font-size:8.5px;line-height:1.1;text-align:right}'
      + '#csEngineStatusPop .lift.f{color:#a3e635}'
      + '#csEngineStatusPop .lift.w{color:#8f9aa6}'
      + '#csEngineStatusPop .lift.a{color:#c98b8b}'
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
  // Which variants a currently-firing setup points at, and why. Empty when nothing fired — the common case.
  // TESTED setups (strong/moderate) and WATCH-tier ones are kept apart all the way to the pixels. A
  // speculative flag rendered in the same lime as a tested one would quietly promote it.
  // Returns variant -> measured lift ($/day on firing days minus that variant's own all-days average),
  // so a cell can show the NUMBER rather than just "this one". `side` picks favours vs avoid.
  function setupLifts(s, tier, side) {
    const out = new Map();
    const b = s && s.setups;
    if (!b || !b.ok || !Array.isArray(b.setups)) return out;
    for (const st of b.setups) {
      const watch = st.strength === 'watch';
      if ((tier === 'watch') !== watch) continue;
      for (const e of (st[side === 'avoid' ? 'avoid' : 'favors'] || [])) {
        // Keep the largest-magnitude claim if two setups ever name the same variant.
        if (!out.has(e.v) || Math.abs(e.lift) > Math.abs(out.get(e.v))) out.set(e.v, e.lift);
      }
    }
    return out;
  }
  const money0 = (n) => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n)).toLocaleString();
  function favourTitle(s, name) {
    const b = s && s.setups; if (!b || !b.setups) return '';
    const hit = b.setups.filter(st => [...(st.favors || []), ...(st.avoid || [])].some(e => e.v === name));
    // Carry the SAMPLE SIZE and the caveat into the tooltip. A green mark on a trading screen gets
    // trusted well past its evidence; the n and the caveat are the only things holding that in check.
    return hit.map(st => {
      const mine = [...(st.favors || []), ...(st.avoid || [])].find(e => e.v === name);
      return `${st.label}: ${st.expect}\n\n`
      + (mine ? `${name} measured lift on these days: ${money0(mine.lift)}/day\n\n` : '')
      + `Why: ${st.why}\nEvidence: ${st.evidence}\n`
      + `Fires on ${st.firesPct}% of days (n=${st.n}), ${st.tested}.\nCaveat: ${st.caveat}`;
    }).join('\n\n');
  }
  // One line above the grid when a setup is live, so it is visible without hovering a cell.
  function setupBanner(s) {
    const b = s && s.setups;
    if (!b || !b.ok || !b.setups || !b.setups.length) return '';
    return b.setups.map(st => {
      const w = st.strength === 'watch';
      const list = (arr, sign) => (arr || []).map(e => `${e.v} ${money0(e.lift)}`).join(' · ')
        || (sign === 'fav' ? 'none — no variant gained on this pattern' : '');
      const fav = (st.favors && st.favors.length) ? `<div class="row">favours: ${list(st.favors, 'fav')}</div>`
        : `<div class="row dim">favours: ${list(st.favors, 'fav')}</div>`;
      const avo = (st.avoid && st.avoid.length) ? `<div class="row dim">avoid: ${list(st.avoid, 'avo')}</div>` : '';
      return `<div class="cssetup${w ? ' watch' : ''}" title="${String(st.caveat).replace(/"/g, '&quot;')}">`
        + `${w ? '△' : '▲'} <b>${st.label}</b> — ${st.expect}`
        + `<span class="n"> · fires on ${st.firesPct}% of days (n=${st.n}), ${st.tested}</span>`
        + fav + avo
        + `<div class="row dim">why: ${st.why}</div></div>`;
    }).join('');
  }

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
        // WATCHED = on the six-variant observation list. FAVOURED = a named start-of-day setup fired
        // today and points at this variant. They are deliberately different marks: one is a standing
        // choice, the other is a condition that is true right now and will be false tomorrow.
        const watched = (s.watchlist || []).includes(name);
        const favTested = setupLifts(s, 'tested', 'favors'), favWatch = setupLifts(s, 'watch', 'favors');
        const avoidAll = new Map([...setupLifts(s, 'tested', 'avoid'), ...setupLifts(s, 'watch', 'avoid')]);
        const favoured = favTested.has(name);
        const watchTier = !favoured && favWatch.has(name);
        const avoided = !favoured && !watchTier && avoidAll.has(name);
        const lift = favoured ? favTested.get(name) : watchTier ? favWatch.get(name) : avoidAll.get(name);
        const marks = (watched ? '<span class="wl" title="on the watchlist — under active observation against live sessions">◆</span>' : '')
          + (favoured ? `<span class="fav" title="${esc(favourTitle(s, name))}">▲</span>` : '')
          + (watchTier ? `<span class="favw" title="${esc(favourTitle(s, name))}">△</span>` : '')
          + (avoided ? `<span class="avo" title="${esc(favourTitle(s, name))}">▽</span>` : '');
        // The measured lift, on the cell. A badge that says "favoured" without saying BY HOW MUCH invites
        // the reader to supply their own magnitude, which is how a +$337 edge and a +$5,468 one end up
        // looking the same.
        const liftEl = (favoured || watchTier || avoided)
          ? `<div class="lift ${favoured ? 'f' : watchTier ? 'w' : 'a'}">${money0(lift)}/d</div>` : '';
        body += `<td class="c${armed ? ' armed' : ''}${sel ? ' sel' : ''}${watched ? ' wlc' : ''}${favoured ? ' fav' : ''}${watchTier ? ' favw' : ''}${avoided ? ' avo' : ''}"${o.pick ? ` data-variant="${name}"` : ''} title="${esc(cellTitle(r))}">`
          + (o.pick ? `<div class="vname">${name}${marks}</div>` : (marks ? `<div class="mk">${marks}</div>` : ''))
          + `<div class="pnl" style="color:${col}">${money(pnl)}</div>`
          + `<div class="sub">${r.opens}o/${r.covers}c/${r.coverFills}f</div>`
          + liftEl
          + (armed ? `<div class="ord">⚡${ro.sent || 0}/${ro.canceled || 0}x/${ro.filled || 0}f</div>` : '')
          + '</td>';
      }
      body += '</tr>';
    }
    body += '</tbody></table>';
    const missing = (s.runs || []).length - shown;
    const uncCount = (s.runs || []).filter(r => /-unc$/.test(r.variant)).length;
    const foot = missing > 0
      ? `<div class="csfoot">+ ${missing} run(s) not shown`
        + (uncCount ? ` — includes ${uncCount} uncapped (-unc) twin(s), hidden here; see the compare page` : '')
        + `</div>`
      : '';
    return hdr + setupBanner(s) + body + foot;
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
    const badgeHtml =
      (blocked ? `<span style="background:#b3261e;color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif;margin-right:4px">NOT TRADING</span>` : '')
      + `<span style="background:${badgeColor(s.mode)};color:#fff;padding:1px 6px;border-radius:3px;font:bold 11px sans-serif">${s.mode}</span>`;
    const statsHtml = (inline ? `<span style="font:11px monospace;color:#999">${inline}</span>` : '')
      + `<span style="font:11px monospace;color:#bbb">${inline ? ' · ' : ''}~${tickMin}m</span>`;
    const ie = inlineEl();
    c.innerHTML = badgeHtml + (ie ? '' : statsHtml);
    if (ie) { ie.innerHTML = statsHtml; ie.title = c.title; }

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
      if (r.ok) { const s = await r.json(); lastStatus = s; renderBanner(s); render(s); window.CandleSpreadStatus._emit(s); }
      else if (c) c.innerHTML = `<span style="font:11px monospace;color:#c0392b">engine status ${r.status}</span>`;
    } catch (e) {
      if (c) c.innerHTML = `<span style="font:11px monospace;color:#999">engine status: offline</span>`;
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    poll();
    setInterval(poll, POLL_MS);
    // Both hosts open the popover — once the stats move to their own line, clicking them must still work
    // or the affordance silently moves out from under the text people actually read.
    for (const host of [el(), inlineEl()]) {
      if (!host) continue;
      host.style.cursor = 'pointer';
      host.title = host.title || 'click for the strategy grid';
      host.addEventListener('click', (e) => { e.stopPropagation(); togglePop(el() || host); });
    }
    document.addEventListener('click', hidePop);                 // click elsewhere closes it
    window.addEventListener('resize', hidePop);
  });

  // Exposed so the positions-source bar can use the SAME grid as a strategy picker instead of a dropdown.
  // Exposed so compare.html can mark ITS grid from the same payload — one fetch, one interpretation.
  // `onStatus` fires on every successful poll so a page can re-render when the setups change.
  const statusListeners = [];
  window.CandleSpreadStatus = {
    openStrategyPicker, hasStatus: () => !!lastStatus,
    getStatus: () => lastStatus,
    onStatus: (fn) => { statusListeners.push(fn); if (lastStatus) { try { fn(lastStatus); } catch (e) {} } },
    _emit: (s) => statusListeners.forEach(fn => { try { fn(s); } catch (e) {} }),
  };
})();
