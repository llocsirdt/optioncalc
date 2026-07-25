// Client UI wiring for "Risk Offsetting Opportunities": renders the curated
// hedge candidates from shared/spread-hedge-strategy.js in place of the old
// exhaustive server+client offsetting search. Only supports a single 2-leg
// spread position for now (see shared/spread-hedge-strategy.js header) —
// support for more complex multi-leg positions comes later.

let hedgeCandidatesForUI = [];

function getSingleSpreadPosition() {
  const legs = (typeof fullOptionArray !== 'undefined' ? fullOptionArray : [])
    .filter(opt => opt.qty !== 0 && opt.type && opt.strike !== null)
    .map(opt => ({ qty: opt.qty, type: opt.type, strike: opt.strike, cost: opt.costAdjustment || 0 }));

  if (legs.length !== 2) return null;
  return { legs };
}

function formatHedgeMoney(value) {
  if (value === Infinity) return 'Unbounded gain';
  if (value === -Infinity) return 'Unbounded loss';
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function renderHedgeCandidatesHtml(candidates) {
  if (candidates.length === 0) {
    return '<div class="offsetting-trades"><h4>🎯 Risk Offsetting Opportunities</h4><p>No viable hedge candidates found in the current chain.</p></div>';
  }

  // Candidates already arrive sorted best-to-worst by rankScore (see
  // shared/spread-hedge-strategy.js). Dimming is based on lockedInProfit alone
  // for now — rankScore's "low" cutoff isn't calibrated yet since its scale
  // differs from the old locked/potential ratio (see rankCandidateScore's
  // comment for what it actually measures).
  const rows = candidates.map((c, index) => {
    const costLessThanLockedClass = Math.abs(c.cost) < c.lockedInProfit ? 'cost-less-than-locked' : '';
    const profitClass = c.lockedInProfit > 0 ? 'profit-positive' : 'profit-neutral';
    const familyClass = c.family === 'same-side' ? 'credit' : 'spread'; // credit offsets get a green bar, debit offsets stay blue
    const weakClass = c.lockedInProfit < 0 ? 'low-locked-profit' : '';
    const legsSummary = c.legs.map(l => `${l.qty > 0 ? '+' : ''}${l.qty}${l.type.toUpperCase()}${l.strike}`).join(', ');

    return `
      <div class="offset-trade ${familyClass} ${weakClass} ${costLessThanLockedClass}"
           onclick="selectHedgeCandidateInTable(${index})"
           title="Click to select these options in the table">
        <div class="trade-description">
          <strong>${c.label}</strong>
          <div class="trade-action">${legsSummary}</div>
          <div class="trade-cost">Cost: ${formatHedgeMoney(c.cost)}</div>
        </div>
        <div class="trade-metrics">
          <div class="trade-potential">Potential: ${formatHedgeMoney(c.profitPotential)}</div>
          <div class="trade-locked-profit">Locked: ${formatHedgeMoney(c.lockedInProfit)}</div>
          <div class="trade-score ${profitClass}">Score: ${(c.rankScore * 100).toFixed(1)}%</div>
        </div>
        <button onclick="event.stopPropagation(); loadHedgeCandidateIntoCalculator(${index})">Add to calculator</button>
      </div>
    `;
  }).join('');

  return `<div class="offsetting-trades"><h4>🎯 Risk Offsetting Opportunities</h4>${rows}</div>`;
}

function renderHedgeCandidatesMessage(message) {
  return `<div class="offsetting-trades"><h4>🎯 Risk Offsetting Opportunities</h4><p>${message}</p></div>`;
}

function updateHedgeCandidatesUI() {
  const col4Element = document.getElementById('container-col4');
  if (!col4Element) return;

  const selectedOffsetAnalysis = document.getElementById('selected-offset-analysis');

  let html;
  const position = getSingleSpreadPosition();

  if (!position) {
    hedgeCandidatesForUI = [];
    html = renderHedgeCandidatesMessage('Load exactly one 2-leg spread to see hedge suggestions (support for more positions is coming).');
  } else {
    try {
      const chainData = getCurrentChainData();
      const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, chainData);
      hedgeCandidatesForUI = candidates;
      html = renderHedgeCandidatesHtml(candidates);
    } catch (err) {
      hedgeCandidatesForUI = [];
      html = renderHedgeCandidatesMessage(err.message);
    }
  }

  col4Element.innerHTML = html;
  if (selectedOffsetAnalysis) {
    col4Element.insertBefore(selectedOffsetAnalysis, col4Element.firstChild);
  }
}

function loadHedgeCandidateIntoCalculator(index) {
  const candidate = hedgeCandidatesForUI[index];
  const position = getSingleSpreadPosition();
  if (!candidate || !position) return;

  const textInput = document.getElementById('textInput');
  if (!textInput) return;

  const combinedTokens = position.legs
    .map(leg => `${leg.qty}${leg.type}${leg.strike}@${leg.cost}`)
    .concat(candidate.legs.map(leg => `${leg.qty}${leg.type.toLowerCase()}${leg.strike}@${leg.cost}`));

  textInput.value = JSON.stringify({ optionArray: combinedTokens.join(',') }, null, 2);
  processInput();
}

// Clicking a candidate card selects its legs' bid/ask cells in the options
// chain table (via the same findAndClickOptionCell primitive the old
// exhaustive UI used), rather than adding the candidate to the calculator.
function selectHedgeCandidateInTable(index) {
  const candidate = hedgeCandidatesForUI[index];
  if (!candidate || typeof findAndClickOptionCell !== 'function') return;

  const clickedPositions = candidate.legs
    .map(leg => findAndClickOptionCell(leg.type.toLowerCase(), leg.strike, leg.qty > 0 ? 'ask' : 'bid'))
    .filter(Boolean);

  if (clickedPositions.length > 0 && typeof updateSelectedPositionsDisplay === 'function' && typeof currentOptionsData !== 'undefined') {
    updateSelectedPositionsDisplay(currentOptionsData);
  }
}
