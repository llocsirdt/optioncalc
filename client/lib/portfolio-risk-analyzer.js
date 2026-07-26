// Client UI wiring for "Analyze Portfolio Risk": computes the combined risk
// curve across every currently-loaded option leg (fullOptionArray, populated
// by processInput() in oc.js — including CSV-imported positions) and searches
// the live option chain for hedges that improve it. See shared/portfolio-risk.js
// for the underlying math; this file is just the UI glue.

let portfolioRiskHedgeCandidates = [];

function togglePortfolioRiskPanel() {
  const container = document.getElementById('portfolio-risk-container');
  const toggleButton = document.getElementById('portfolio-risk-toggle');
  if (!container || !toggleButton) return;

  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? '' : 'none';
  toggleButton.textContent = isHidden ? 'Hide Portfolio Risk' : 'Show Portfolio Risk';

  // Opening the panel runs the analysis immediately — the separate "Analyze
  // Portfolio Risk" button is only needed to retry after an error or to
  // refresh after loading different positions/chain data.
  if (isHidden) {
    analyzePortfolioRiskUI();
  }
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
  // table (stashed in schwab-api.js's lastLiveChainData whenever live data
  // polling refreshes it) instead of making an independent fetch — so this
  // only ever analyzes against the exact same data the user can see on screen,
  // and only while live data is actually enabled.
  if (typeof liveDataEnabled === 'undefined' || !liveDataEnabled) {
    throw new Error('Enable "Start Live Data" first — portfolio risk analysis only runs against the live chain data shown on screen.');
  }

  if (!lastLiveChainData) {
    throw new Error('No live chain data received yet — wait for the next live data update.');
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

function renderPortfolioRiskResults(analysis) {
  const container = document.getElementById('portfolio-risk-results');
  if (!container) return;

  const { baseline, candidates } = analysis;

  let html = `
    <div class="portfolio-risk-baseline">
      <strong>Current aggregate risk</strong><br>
      Worst case: ${formatPnl(baseline.lockedInProfit)} @ ${baseline.worstCasePrice ?? '—'}<br>
      Best case: ${formatPnl(baseline.profitPotential)} @ ${baseline.bestCasePrice ?? '—'}<br>
      ${baseline.unboundedUpsideRisk ? '<span class="portfolio-risk-warning">Unbounded upside risk (naked short calls)</span><br>' : ''}
      ${baseline.unboundedDownsideRisk ? '<span class="portfolio-risk-warning">Unbounded downside risk (naked short puts)</span><br>' : ''}
    </div>
  `;

  if (candidates.length === 0) {
    html += '<p>No improving hedge candidates found in the current chain.</p>';
  } else {
    // Same card layout/scoring as the "Risk Offsetting Opportunities" panel
    // (see offset-card-ui.js) so a candidate surfaced in both places is
    // immediately recognizable as the same trade.
    html += renderOffsetCandidateCards(candidates, 'selectPortfolioRiskCandidateInTable', 'loadPortfolioHedgeCandidate');
  }

  container.innerHTML = html;
}

async function analyzePortfolioRiskUI() {
  const container = document.getElementById('portfolio-risk-results');
  if (container) container.innerHTML = '<p>Analyzing...</p>';

  try {
    const legs = getCurrentPortfolioLegs();
    if (legs.length === 0) {
      throw new Error('No option positions loaded — enter or import positions first.');
    }

    const chainData = getCurrentChainData();
    const analysis = PortfolioRisk.findPortfolioHedgeCandidates(legs, chainData);
    portfolioRiskHedgeCandidates = analysis.candidates;
    renderPortfolioRiskResults(analysis);
  } catch (err) {
    if (container) container.innerHTML = `<p class="portfolio-risk-error">${err.message}</p>`;
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
