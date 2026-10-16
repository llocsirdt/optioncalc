'use strict';
/**
 * Verify the clock offset of a broker export against the underlying (pure).
 *
 * With no NDX intraday for the period, the underlying proxy is NQ 1m minus that day's NQ->NDX basis
 * (supplied by the caller as underlyingAt(date, etSec) -> S | null). For each candidate offset h (export
 * clock minus ET, hours) every option fill is tested two model-free ways:
 *   1. INTRINSIC BOUND: an option can never trade below intrinsic, so price >= intrinsic(S) - tol.
 *      A wrong clock puts S at the wrong minute and produces sub-intrinsic fills on ITM legs.
 *   2. PUT-CALL PARITY: a call and put at the SAME strike filled within `pairWindowSec` give
 *      S_implied = K + C - P (0DTE: carry ~0). Its error vs the proxy should be smallest at the true offset.
 * Fills: [{ date, etSecRaw (export clock seconds), right, strike, price }].
 */
function scoreOffsets(fills, underlyingAt, { candidates = [0, 1, 2, 3, 4, 5], tol = 5, pairWindowSec = 120 } = {}) {
  const rows = [];
  for (const h of candidates) {
    let n = 0, viol = 0, outside = 0, worst = 0;
    const tvs = [];
    for (const f of fills) {
      const sec = f.secRaw - h * 3600;
      if (sec < 9.5 * 3600 || sec > 16.25 * 3600) { outside++; continue; }
      const S = underlyingAt(f.date, sec);
      if (S == null) continue;
      n++;
      const intr = f.right === 'C' ? Math.max(0, S - f.strike) : Math.max(0, f.strike - S);
      const tv = f.price - intr;
      tvs.push(tv);
      if (tv < -tol) { viol++; worst = Math.min(worst, tv); }
    }
    // parity pairs
    const errs = [];
    const byDay = new Map();
    for (const f of fills) { if (!byDay.has(f.date)) byDay.set(f.date, []); byDay.get(f.date).push(f); }
    for (const [date, fs] of byDay) {
      const calls = fs.filter(f => f.right === 'C'), puts = fs.filter(f => f.right === 'P');
      for (const c of calls) {
        const p = puts.filter(x => x.strike === c.strike && Math.abs(x.secRaw - c.secRaw) <= pairWindowSec)
          .sort((a, b) => Math.abs(a.secRaw - c.secRaw) - Math.abs(b.secRaw - c.secRaw))[0];
        if (!p) continue;
        const sec = (c.secRaw + p.secRaw) / 2 - h * 3600;
        const S = underlyingAt(date, sec);
        if (S == null) continue;
        errs.push(c.strike + c.price - p.price - S);
      }
    }
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    rows.push({
      offsetHours: h, legsTested: n, legsOutsideSession: outside, subIntrinsic: viol, worstBelowIntrinsic: Math.round(worst * 100) / 100,
      medianTimeValue: med(tvs) == null ? null : Math.round(med(tvs) * 100) / 100,
      parityPairs: errs.length,
      parityMedianAbsErr: errs.length ? Math.round(med(errs.map(Math.abs)) * 100) / 100 : null,
      parityMedianErr: errs.length ? Math.round(med(errs) * 100) / 100 : null,
    });
  }
  return rows;
}

module.exports = { scoreOffsets };
