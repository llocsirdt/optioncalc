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

  // getOptionsChainFromSchwab returns null on a hard failure (not connected, fetch
  // error, non-2xx response), but a "successful" call can still come back without
  // usable data (e.g. malformed/empty payload) — treat that as a failure too,
  // rather than silently searching against an empty {call:{}, put:{}} chain and
  // reporting "no candidates found" as if the positions were already hedged.
  const hasCallData = rawChainData?.callExpDateMap && Object.keys(rawChainData.callExpDateMap).length > 0;
  const hasPutData = rawChainData?.putExpDateMap && Object.keys(rawChainData.putExpDateMap).length > 0;
  if (!hasCallData && !hasPutData) {
    throw new Error(`No live option chain data available for ${chainsSymbol} ${expiration} — check that Schwab is connected.`);
  }

  // The Symbol field is trusted as the correct symbol for the loaded positions
  // (positions are even saved to localStorage keyed by it) — but that doesn't
  // guarantee the chain we just fetched is actually for that symbol. Schwab
  // echoes back the resolved symbol (e.g. "$NDX" for a request of "%24NDX"),
  // so cross-check it rather than blindly trusting whatever came back.
  const normalizeSymbol = (raw) => decodeURIComponent(raw || '').replace(/^\$/, '').replace(/\.X$/i, '').trim().toUpperCase();
  const responseSymbol = normalizeSymbol(rawChainData.symbol);
  const requestedSymbol = normalizeSymbol(symbol);
  if (responseSymbol && requestedSymbol && responseSymbol !== requestedSymbol) {
    throw new Error(`Option chain response symbol "${rawChainData.symbol}" does not match the requested symbol "${symbol}" — refusing to analyze against mismatched chain data.`);
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
