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

function renderHedgeCandidatesHtml(candidates, positionLegs) {
  if (candidates.length === 0) {
    return '<div class="offsetting-trades"><h4>🎯 Risk Offsetting Opportunities</h4><p>No viable hedge candidates found in the current chain.</p></div>';
  }

  // Candidates already arrive sorted best-to-worst by rankScore (see
  // shared/spread-hedge-strategy.js). Dimming is based on lockedInProfit alone
  // for now — rankScore's "low" cutoff isn't calibrated yet since its scale
  // differs from the old locked/potential ratio (see rankCandidateScore's
  // comment for what it actually measures).
  const rows = renderOffsetCandidateCards(candidates, 'selectHedgeCandidateInTable', 'loadHedgeCandidateIntoCalculator', positionLegs);
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
      // Anything that opposes an existing position leg sinks to the bottom —
      // still shown, just deprioritized rather than reordered by score.
      const candidates = sortWithConflictsLast(SpreadHedgeStrategy.findHedgeCandidates(position, chainData), position.legs);
      hedgeCandidatesForUI = candidates;
      html = renderHedgeCandidatesHtml(candidates, position.legs);
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
// chain table, rather than adding the candidate to the calculator (see
// selectCandidateLegsInTable in offset-card-ui.js).
function selectHedgeCandidateInTable(index, cardElement) {
  selectCandidateLegsInTable(hedgeCandidatesForUI[index], cardElement);
}
