// Client UI wiring for "Analyze Portfolio Risk": computes the combined risk
// curve across every currently-loaded option leg (fullOptionArray, populated
// by processInput() in oc.js — including CSV-imported positions) and searches
// the live option chain for hedges that improve it. See shared/portfolio-risk.js
// for the underlying math; this file is just the UI glue.

let portfolioRiskHedgeCandidates = [];

// "Recently surfaced — best" rolling history: keeps the last few top-ranked offsets around even
// after they drop out of the live results, so a good trade that was identified while you weren't
// watching is still visible (timestamped with when it was last the best). Cleared when the loaded
// positions change (see analyzePortfolioRiskUI) since older offsets no longer apply.
const RECENT_BEST_MAX = 5;
let recentBestOffsets = [];   // [{ key, candidate, firstSurfacedAt, lastSurfacedAt }], most-recent first
let lastPositionsSig = null;  // signature of the legs the recent list was built against

// Stable identity of a trade (its set of legs), so the same offset re-surfacing just refreshes its
// timestamp instead of duplicating.
function candidateKey(candidate) {
  return (candidate.legs || []).map(l => `${l.qty}${(l.type || '').toUpperCase()}${l.strike}`).sort().join(',');
}
function positionsSignature(legs) {
  return (legs || []).map(l => `${l.qty}${l.type}${l.strike}`).sort().join('|');
}

// The current "best" offer = the top-ranked candidate that isn't quality-flagged or opposing an
// existing leg. `candidates` is already globally ranked (tier, then rankScore), so the first clean
// one is the best. (How we define "best" is intentionally simple for now — easy to widen to top-N
// or add a score floor later.)
function pickBestCandidate(candidates, legs) {
  return candidates.find(c => !getCandidateQualityFlag(c) && !candidateHasOppositeLeg(c.legs, legs)) || null;
}

function recordRecentBest(candidate) {
  if (!candidate) return;
  const key = candidateKey(candidate);
  const now = Date.now();
  const existing = recentBestOffsets.find(e => e.key === key);
  if (existing) {
    existing.lastSurfacedAt = now;
    existing.candidate = candidate;   // refresh with the latest pricing/metrics
  } else {
    recentBestOffsets.push({ key, candidate, firstSurfacedAt: now, lastSurfacedAt: now });
  }
  recentBestOffsets.sort((a, b) => b.lastSurfacedAt - a.lastSurfacedAt);
  if (recentBestOffsets.length > RECENT_BEST_MAX) recentBestOffsets.length = RECENT_BEST_MAX;
}

function formatRecentTime(ms) {
  const t = new Date(ms).toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const mins = Math.floor((Date.now() - ms) / 60000);
  const age = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return { t, age };
}

// The "Recently surfaced — best" section, rendered at the top of the panel like the other groups.
// Cards reuse the standard offset card, but their click/add handlers index into recentBestOffsets
// (not the live candidates array), since these may no longer be in the live results.
function renderRecentBestSection(positionLegs) {
  if (!recentBestOffsets.length) return '';
  const cards = recentBestOffsets.map((entry, i) => {
    const { t, age } = formatRecentTime(entry.lastSurfacedAt);
    const card = renderOffsetCandidateCard(entry.candidate, i, 'selectRecentOffsetInTable', 'loadRecentOffset', positionLegs, 'offset-recent');
    return `<div class="offset-recent-wrap">${card}` +
      `<div class="offset-recent-meta" title="When this trade was last the top-ranked offset">last surfaced ${t} · ${age}</div></div>`;
  }).join('');
  return `
    <div class="offset-group offset-recent-group" data-group="recent">
      <div class="offset-group-header">★ Recently surfaced — best <span class="offset-group-count">(${recentBestOffsets.length})</span></div>
      <div class="offset-group-cards">${cards}</div>
    </div>`;
}

function loadRecentOffset(index) {
  const entry = recentBestOffsets[index];
  if (!entry) return;
  const textInput = document.getElementById('textInput');
  if (!textInput) return;
  const existingLegs = getCurrentPortfolioLegs();
  const combinedLegTokens = existingLegs
    .map(leg => `${leg.qty}${leg.type}${leg.strike}@${leg.cost}`)
    .concat(entry.candidate.legs.map(leg => `${leg.qty}${leg.type.toLowerCase()}${leg.strike}@${leg.cost}`));
  textInput.value = JSON.stringify({ optionArray: combinedLegTokens.join(',') }, null, 2);
  processInput();
}

function selectRecentOffsetInTable(index, cardElement) {
  const entry = recentBestOffsets[index];
  if (entry) selectCandidateLegsInTable(entry.candidate, cardElement);
}

function getCurrentPortfolioLegs() {
  return (typeof fullOptionArray !== 'undefined' ? fullOptionArray : [])
    .filter(opt => opt.qty !== 0 && opt.type && opt.strike !== null)
    .map(opt => ({
      qty: opt.qty,
      type: opt.type,
      strike: opt.strike,
      cost: opt.costAdjustment || 0
    }));
}

function getCurrentChainData() {
  // Reuses whatever chain data is already backing the "Live Options Chain" UI
  // table (stashed in schwab-api.js's lastLiveChainData whenever a chain snapshot
  // loads) instead of making an independent fetch — so this only ever analyzes
  // against the exact same data the user can see on screen. Works off a single
  // snapshot too (e.g. the one auto-loaded outside market hours), so it no longer
  // requires continuous live data to be enabled — just that a snapshot exists.
  if (!lastLiveChainData) {
    throw new Error('No live chain data yet — waiting for the next update.');
  }

  const rawChainData = lastLiveChainData.raw;
  const hasCallData = rawChainData?.callExpDateMap && Object.keys(rawChainData.callExpDateMap).length > 0;
  const hasPutData = rawChainData?.putExpDateMap && Object.keys(rawChainData.putExpDateMap).length > 0;
  if (!hasCallData && !hasPutData) {
    throw new Error(`No usable chain data for ${lastLiveChainData.symbol} ${lastLiveChainData.expiration} — check that Schwab is connected.`);
  }

  const expiration = document.getElementById('expiration-dropdown')?.value;
  if (expiration && lastLiveChainData.expiration !== expiration) {
    throw new Error(`Live chain data is for expiration ${lastLiveChainData.expiration}, but ${expiration} is currently selected — wait for the next live data update.`);
  }

  // The Symbol field is trusted as the correct symbol for the loaded positions
  // (positions are even saved to localStorage keyed by it) — but that doesn't
  // guarantee the live chain data actually matches it right now (e.g. the field
  // was edited after the last live data tick). Schwab echoes back the resolved
  // symbol (e.g. "$NDX" for a request of "%24NDX"), so cross-check it rather
  // than blindly trusting whatever's cached.
  const symbol = document.getElementById('symbol-input')?.value.trim();
  const normalizeSymbol = (raw) => decodeURIComponent(raw || '').replace(/^\$/, '').replace(/\.X$/i, '').trim().toUpperCase();
  const responseSymbol = normalizeSymbol(rawChainData.symbol);
  const requestedSymbol = normalizeSymbol(symbol);
  if (responseSymbol && requestedSymbol && responseSymbol !== requestedSymbol) {
    throw new Error(`Live chain data symbol "${rawChainData.symbol}" does not match the Symbol field "${symbol}" — refusing to analyze against mismatched chain data.`);
  }

  return {
    call: rawChainData.callExpDateMap || {},
    put: rawChainData.putExpDateMap || {}
  };
}

function formatPnl(value) {
  if (value === Infinity) return 'Unbounded gain';
  if (value === -Infinity) return 'Unbounded loss';
  if (!Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

function renderPortfolioRiskResults(analysis, positionLegs) {
  const container = document.getElementById('portfolio-risk-results');
  if (!container) return;

  // "Current aggregate risk" now lives in the Processed Output (above Key Points),
  // computed in oc.js's processInput — see renderAggregateRisk there.
  const { candidates } = analysis;

  // Rolling "best" history first, so recently-identified offsets stay visible even when the live
  // search currently finds nothing.
  let html = renderRecentBestSection(positionLegs);

  if (candidates.length === 0) {
    html += recentBestOffsets.length
      ? '<p>No improving hedge candidates in the current chain right now.</p>'
      : '<p>No improving hedge candidates found in the current chain.</p>';
  } else {
    // Same card layout/scoring as the "Risk Offsetting Opportunities" panel
    // (see offset-card-ui.js) so a candidate surfaced in both places is
    // immediately recognizable as the same trade — but grouped into per-type
    // sections (two-leg covers / tail-risk / valley) with the best-scoring group
    // first, rather than one flat intermingled list.
    html += renderGroupedOffsetCandidateCards(candidates, 'selectPortfolioRiskCandidateInTable', 'loadPortfolioHedgeCandidate', positionLegs);
  }

  container.innerHTML = html;
}

async function analyzePortfolioRiskUI(options = {}) {
  const container = document.getElementById('portfolio-risk-results');
  // On silent auto-refreshes (every live-data cycle) skip the "Analyzing..."
  // placeholder so the panel updates in place instead of flickering.
  if (!options.silent && container) container.innerHTML = '<p>Analyzing...</p>';

  try {
    const legs = getCurrentPortfolioLegs();
    // Positions changed (e.g. a new CSV import, a manual edit, or adding a hedge) → the remembered
    // "recently surfaced" offsets are stale, so drop them and start the rolling history fresh.
    const sig = positionsSignature(legs);
    if (sig !== lastPositionsSig) { recentBestOffsets = []; lastPositionsSig = sig; }
    if (legs.length === 0) {
      throw new Error('No option positions loaded — enter or import positions first.');
    }

    const chainData = getCurrentChainData();
    const analysis = PortfolioRisk.findPortfolioHedgeCandidates(legs, chainData);
    // Only searches (and only does anything) when both the far-low and
    // far-high price extremes are already underwater — a single spread can't
    // fix that, but a call spread above the money + put spread below it,
    // added together, sometimes can. Merged into the same list/ranking so it
    // reads as one set of options rather than a separate section.
    const tailRisk = PortfolioRisk.findTailRiskHedgeCandidates(legs, chainData);
    // Only searches (and only does anything) when the worst case is a LOCAL
    // DIP somewhere in the middle of the curve — both tails already fine,
    // just an interior notch — which a butterfly centered near the dip can
    // fill without disturbing the rest of the curve.
    const localDip = PortfolioRisk.findLocalDipHedgeCandidates(legs, chainData);
    const merged = analysis.candidates.concat(tailRisk.candidates, localDip.candidates).sort(PortfolioRisk.compareCandidatesByTier);
    // Anything that opposes an existing position leg sinks to the bottom —
    // still shown, just deprioritized rather than reordered by score.
    const candidates = sortWithConflictsLast(merged, legs);
    portfolioRiskHedgeCandidates = candidates;
    // Remember the current best (top-ranked, clean) offset in the rolling history before rendering.
    recordRecentBest(pickBestCandidate(candidates, legs));
    renderPortfolioRiskResults({ baseline: analysis.baseline, candidates }, legs);
  } catch (err) {
    // On a silent auto-refresh, leave the last good results in place rather than
    // clobbering them with a transient error (e.g. a momentary chain/expiration
    // mismatch between refresh cycles).
    if (!options.silent && container) {
      container.innerHTML = `<p class="portfolio-risk-error">${err.message}</p>`;
    }
  }
}

function loadPortfolioHedgeCandidate(index) {
  const candidate = portfolioRiskHedgeCandidates[index];
  if (!candidate) return;

  const textInput = document.getElementById('textInput');
  if (!textInput) return;

  const existingLegs = getCurrentPortfolioLegs();
  const combinedLegTokens = existingLegs
    .map(leg => `${leg.qty}${leg.type}${leg.strike}@${leg.cost}`)
    .concat(candidate.legs.map(leg => `${leg.qty}${leg.type.toLowerCase()}${leg.strike}@${leg.cost}`));

  textInput.value = JSON.stringify({ optionArray: combinedLegTokens.join(',') }, null, 2);
  processInput();
}

// Clicking a candidate card selects its legs' bid/ask cells in the options
// chain table, rather than adding the candidate to the calculator (see
// selectCandidateLegsInTable in offset-card-ui.js).
function selectPortfolioRiskCandidateInTable(index, cardElement) {
  selectCandidateLegsInTable(portfolioRiskHedgeCandidates[index], cardElement);
}
