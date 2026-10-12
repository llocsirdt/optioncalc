// DIVERGENCE BANNER (2026-10-12, user): "if they ever disagree the UI should indicate so loudly". A full-width
// red bar at the top of the page, and a ⚠ in the tab title, when a LIVE run's record says either:
//   - the engine's legs and the Schwab account's positions disagree (state.positionReconcile, read from the
//     account itself), or the engine's book disagrees with the orders that really filled (state.bookReconcile,
//     only once it has persisted past a fill landing between two passes), or
//   - an order has been rejected by Schwab repeatedly (state.rejectStreaks, 3+ in a row, still recent).
// An uncovered position is NOT an alert: that is normal. Simulated / test runs never alert.
// Pure alert derivation + one DOM renderer; isomorphic for tests.
(function (root) {
  'use strict';

  const REJECT_MIN = 3;
  const REJECT_RECENT_MS = 10 * 60 * 1000;
  const BOOK_PERSIST_MS = 60 * 1000;

  // The three fields, wherever they come from: a run record's state, or a /status row (which carries the same
  // three verbatim). `label` prefixes each line so a page watching several live variants says which one.
  function alertsFor(st, label, nowMs) {
    const now = nowMs != null ? nowMs : Date.now();
    const pre = label ? `${label}: ` : '';
    const out = [];
    const pr = st && st.positionReconcile;
    if (pr && (pr.severity === 'DIVERGENT' || pr.severity === 'UNREADABLE')) {
      const kinds = Object.entries(pr.byKind || {}).map(([k, v]) => `${v} ${k}`).join(', ');
      out.push(pre + (pr.severity === 'UNREADABLE'
        ? `SCHWAB POSITIONS UNREADABLE — ${(pr.unparsedSymbols || []).length} symbol(s) could not be parsed; the engine cannot confirm what the account holds`
        : `ENGINE ≠ SCHWAB ACCOUNT — ${pr.diffs} leg(s) disagree (${kinds}); the account is the truth`));
    }
    const br = st && st.bookReconcile;
    if (br && br.severity === 'DIVERGENT' && br.at && now - Date.parse(br.at) >= BOOK_PERSIST_MS) {
      const kinds = Object.entries(br.byKind || {}).map(([k, v]) => `${v} ${k}`).join(', ');
      out.push(`${pre}ENGINE ≠ SCHWAB FILLS — ${br.diffs} position(s) disagree with the orders that filled (${kinds})`);
    }
    for (const [key, r] of Object.entries((st && st.rejectStreaks) || {})) {
      if (!r || !(r.count >= REJECT_MIN)) continue;
      if (r.lastAt && now - Date.parse(r.lastAt) > REJECT_RECENT_MS) continue;
      const [what, pos] = key.split(':');
      out.push(`${pre}SCHWAB REJECTED ${String(r.kind || what).toUpperCase()} ×${r.count}${pos ? ` (position …${pos.slice(-4)})` : ''}: ${r.lastReason || 'no reason given'}`);
    }
    return out;
  }

  // A run record (debug page): live only — a simulated or test run is meant to differ from the account.
  function divergenceAlerts(record, nowMs) {
    const rec = (record && record.record) || record || {};
    if (!rec.config || rec.config.dryRun !== false) return [];
    return alertsFor(rec.state || {}, null, nowMs);
  }

  // The /status payload (index + compare): every LIVE run, labelled by variant.
  function alertsFromStatus(s, nowMs) {
    const out = [];
    for (const r of (s && s.runs) || []) if (r && r.mode === 'live') out.push(...alertsFor(r, r.variant, nowMs));
    return out;
  }

  const BASE_TITLE = typeof document !== 'undefined' ? document.title.replace(/^⚠ /, '') : '';
  function showDivergenceBanner(alerts) {
    if (typeof document === 'undefined') return;
    let bar = document.getElementById('divergence-banner');
    if (!alerts || !alerts.length) {
      if (bar) bar.remove();
      document.title = BASE_TITLE;
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'divergence-banner';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#c62828;color:#fff;font-weight:700;'
        + 'padding:10px 16px;font-size:15px;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,.35)';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.innerHTML = alerts.map((a) => `<div>⚠ ${String(a).replace(/</g, '&lt;')}</div>`).join('');
    document.title = `⚠ ${BASE_TITLE}`;
  }

  const api = { divergenceAlerts, alertsFromStatus, alertsFor, showDivergenceBanner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') { root.divergenceAlerts = divergenceAlerts; root.alertsFromStatus = alertsFromStatus; root.showDivergenceBanner = showDivergenceBanner; }
})(typeof window !== 'undefined' ? window : this);
