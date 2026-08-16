// Client UI wiring for "Analyze Portfolio Risk": computes the combined risk
// curve across every currently-loaded option leg (fullOptionArray, populated
// by processInput() in oc.js — including CSV-imported positions) and searches
// the live option chain for hedges that improve it. See shared/portfolio-risk.js
// for the underlying math; this file is just the UI glue.

let portfolioRiskHedgeCandidates = [];

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

  let html = '';

  if (candidates.length === 0) {
    html += '<p>No improving hedge candidates found in the current chain.</p>';
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
