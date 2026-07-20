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

async function fetchCurrentChainData() {
  const symbol = document.getElementById('symbol-input')?.value.trim();
  const expiration = document.getElementById('expiration-dropdown')?.value;
  if (!symbol || !expiration) {
    throw new Error('Select a symbol and expiration in the Live Options Chain panel first.');
  }

  const chainsSymbol = typeof mapSymbolForAPI === 'function' ? mapSymbolForAPI(symbol, 'chains') : symbol;
  const rawChainData = await getOptionsChainFromSchwab(chainsSymbol, expiration, { strike_count: 75 });
  if (!rawChainData) {
    throw new Error('Failed to fetch option chain data.');
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
    html += candidates.slice(0, 10).map((candidate, index) => `
      <div class="portfolio-risk-candidate">
        <strong>${candidate.strategy.replace(/_/g, ' ')}</strong>
        (${candidate.legs.map(leg => `${leg.qty > 0 ? '+' : ''}${leg.qty}${leg.type}${leg.strike}`).join(', ')})
        — cost ${formatPnl(candidate.cost)}<br>
        New worst case: ${formatPnl(candidate.lockedInProfit)} (improves by ${formatPnl(candidate.improvementOverBaseline)})<br>
        New best case: ${formatPnl(candidate.profitPotential)}, score ${candidate.profitPotentialScore.toFixed(2)}
        <button onclick="loadPortfolioHedgeCandidate(${index})">Add to calculator</button>
      </div>
    `).join('');
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

    const chainData = await fetchCurrentChainData();
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
