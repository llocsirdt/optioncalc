// What happened in a candle-spread RUN that should NOT normally happen?
//
// WHY THIS EXISTS. On 2026-10-02 a cover was rejected by Schwab every bar for 40 minutes and an open filled
// without being booked — both were in the run record, and neither was visible anywhere anyone looked. The
// debug page's Mechanisms list counted what the strategy DID; nothing listed what went WRONG. This is that
// list: every count here is expected to be zero on a healthy day, so a non-zero one is a thing to review.
//
// ONE DEFINITION, TWO READERS: the debug page (Mechanisms, shown only when non-zero, in red) and the daily
// review tool (scripts/analyze-candle-spread-run.js, an ANOMALIES block). Add a new anomaly here and both
// pick it up.
(function (root) {
  'use strict';

  const ANOMALIES = [
    { key: 'not-sent', label: 'orders NOT sent',
      decisions: ['open-not-sent', 'cover-not-sent', 'combo-not-sent'] },
    { key: 'replace-not-taken', label: 'replaces NOT taken (refused / blocked / skipped)',
      decisions: ['cover-reprice-not-sent', 'cover-giveup-not-sent', 'open-reprice-not-sent'] },
    { key: 'rejected', label: 'broker REJECTIONS',
      events: (e) => e.type === 'order_dead' && e.status === 'rejected' },
    { key: 'reject-streak', label: 'REPEATED-rejection alarms',
      events: (e) => e.type === 'order_reject_streak' },
    { key: 'unbooked', label: 'broker fills NOT booked',
      decisions: ['broker-fill-unbooked', 'broker-fill-unhandled', 'broker-fill-wrong-side', 'broker-fill-unpriced'] },
    { key: 'replace-race', label: 'replace RACES (original filled mid-replace)',
      events: (e) => e.type === 'order_replace_race' },
    { key: 'broker-error', label: 'broker send / replace / cancel ERRORS',
      events: (e) => e.type === 'order_error' || e.type === 'order_cancel_error' },
    { key: 'poll-error', label: 'order poll ERRORS',
      events: (e) => e.type === 'order_poll_error' },
    // PERSISTENT divergences only. Between Schwab reporting a fill and the engine booking it (~30s) the book
    // check reads DIVERGENT on every healthy fill (measured 2026-10-02: five such blips, each clean within
    // 40s). A divergence counts when the NEXT book check is not clean within 2 minutes, or there is none.
    { key: 'book-divergent', label: 'book vs broker orders DIVERGENT (persistent)', custom: 'book' },
    // The position check logs only when it is NOT clean, so a clear is invisible in the events; judge it by
    // the LATEST check the record holds.
    { key: 'positions-divergent', label: 'account positions vs book DIVERGENT (latest check)', custom: 'positions' },
  ];

  // A short "why" for the rows that carry one, so the review does not have to open the record to start.
  function detailOf(key, hits) {
    if (!hits.length) return null;
    const last = hits[hits.length - 1];
    const t = (x) => (x && x.time ? String(x.time).slice(11, 19) + 'Z ' : '');
    if (key === 'rejected') {
      const reasons = {};
      for (const h of hits) { const r = h.reason || (/\(([^)]+)\)/.exec(h.note || '') || [])[1] || 'no reason recorded'; reasons[r] = (reasons[r] || 0) + 1; }
      return Object.entries(reasons).map(([r, n]) => `${n}x ${r}`).join('; ');
    }
    if (key === 'reject-streak') return `${t(last)}${last.key} x${last.count}: ${last.reason || 'no reason'}`;
    if (key === 'unbooked') { const w = {}; for (const h of hits) w[h.why || h.action] = (w[h.why || h.action] || 0) + 1; return Object.entries(w).map(([k, n]) => `${n}x ${k}`).join('; '); }
    if (key === 'replace-not-taken' || key === 'not-sent') { const w = {}; for (const h of hits) { const k = h.reason || 'unknown'; w[k] = (w[k] || 0) + 1; } return Object.entries(w).slice(0, 3).map(([k, n]) => `${n}x ${k}`).join('; '); }
    if (key === 'positions-divergent' || key === 'book-divergent') return `${t(last)}${last.note || ''}`.slice(0, 160);
    if (key === 'broker-error' || key === 'poll-error') return `${t(last)}${last.note || ''}`.slice(0, 160);
    return null;
  }

  // -> [{ key, label, count, detail }] for every anomaly that FIRED (count > 0), in definition order.
  function anomaliesOf(record) {
    const events = (record && record.events) || [];
    const decisions = [];
    for (const e of events) for (const d of (e.decisions || [])) decisions.push({ ...d, time: d.time || e.time });
    const out = [];
    for (const a of ANOMALIES) {
      let hits = [];
      if (a.decisions) hits = hits.concat(decisions.filter((d) => a.decisions.includes(d.action)));
      if (a.events) hits = hits.concat(events.filter(a.events));
      if (a.custom === 'book') {
        const br = events.filter((e) => e.type === 'book_reconcile');
        br.forEach((e, i) => {
          if (e.severity !== 'DIVERGENT') return;
          const nx = br[i + 1];
          const cleared = nx && nx.severity === 'clean' && (Date.parse(nx.time) - Date.parse(e.time)) <= 120000;
          if (!cleared) hits.push(e);
        });
      }
      if (a.custom === 'positions') {
        const pr = record && record.state && record.state.positionReconcile;
        if (pr && pr.severity === 'DIVERGENT') hits.push({ time: pr.at, note: `${pr.diffs} leg(s) at the last check: ${JSON.stringify(pr.byKind || {})}` });
      }
      if (hits.length) out.push({ key: a.key, label: a.label, count: hits.length, detail: detailOf(a.key, hits) });
    }
    return out;
  }

  const api = { anomaliesOf, ANOMALIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.RunAnomalies = api;
})(typeof window !== 'undefined' ? window : this);
