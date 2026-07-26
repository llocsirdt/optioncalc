// Shared rendering + click-to-select-in-table behavior for hedge/offset
// candidate cards, used by both the single-spread "Risk Offsetting
// Opportunities" panel (hedge-strategy-ui.js) and the aggregate "Portfolio
// Risk" panel (portfolio-risk-analyzer.js) — same card layout, same score,
// same click-to-select behavior, so a candidate that shows up in both places
// is immediately recognizable as the same trade.

function formatOffsetMoney(value) {
  if (value === Infinity) return 'Unbounded gain';
  if (value === -Infinity) return 'Unbounded loss';
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

// True if any candidate leg is the same contract (type + strike) as an
// existing position leg but in the opposite direction (long vs. short) — e.g.
// the position already holds a long put at a strike and this candidate
// includes a short put at that same strike. Not excluded from the list (yet)
// — just flagged so it's visible how often it comes up.
function candidateHasOppositeLeg(candidateLegs, positionLegs) {
  return (positionLegs || []).some(posLeg =>
    candidateLegs.some(leg =>
      leg.type.toLowerCase() === posLeg.type.toLowerCase() &&
      leg.strike === posLeg.strike &&
      Math.sign(leg.qty) !== Math.sign(posLeg.qty)
    )
  );
}

// Moves any candidate that opposes an existing position leg to the bottom of
// the list, without disturbing the existing tier/rankScore order otherwise —
// Array.sort is stable, so returning 0 for a same-conflict-status pair just
// keeps whatever relative order they already arrived in.
function sortWithConflictsLast(candidates, positionLegs) {
  return candidates.slice().sort((a, b) => {
    const aConflict = candidateHasOppositeLeg(a.legs, positionLegs) ? 1 : 0;
    const bConflict = candidateHasOppositeLeg(b.legs, positionLegs) ? 1 : 0;
    return aConflict - bConflict;
  });
}

function renderOffsetCandidateCard(candidate, index, selectFnName, addFnName, positionLegs) {
  const costLessThanLockedClass = Math.abs(candidate.cost) < candidate.lockedInProfit ? 'cost-less-than-locked' : '';
  const profitClass = candidate.lockedInProfit > 0 ? 'profit-positive' : 'profit-neutral';
  const hasOppositeLeg = candidateHasOppositeLeg(candidate.legs, positionLegs);
  // "family" (shift/width/same-side) only exists on the curated single-spread
  // candidates — the aggregate search has no such family, so fall back to
  // classifying by the trade's own cost sign (net credit vs. net debit).
  // tail-risk (a call spread + put spread added together) and local-dip (a
  // butterfly) each get their own color regardless of cost sign, since
  // they're structurally different kinds of trades. A leg that opposes an
  // existing position leg overrides any of these with red.
  const familyClass = hasOppositeLeg
    ? 'conflict'
    : (candidate.family === 'tail-risk' || candidate.family === 'local-dip')
      ? candidate.family
      : (candidate.family
        ? (candidate.family === 'same-side' ? 'credit' : 'spread')
        : (candidate.cost < 0 ? 'credit' : 'spread'));
  const weakClass = candidate.lockedInProfit < 0 ? 'low-locked-profit' : '';
  const legsSummary = candidate.legs.map(l => `${l.qty > 0 ? '+' : ''}${l.qty}${l.type.toUpperCase()}${l.strike}`).join(', ');
  const conflictNote = hasOppositeLeg
    ? '<div class="trade-conflict" title="One of this trade\'s legs is the opposite direction of the same strike/type already in your position">⚠ Opposes an existing leg</div>'
    : '';

  return `
    <div class="offset-trade ${familyClass} ${weakClass} ${costLessThanLockedClass}"
         onclick="${selectFnName}(${index}, this)"
         title="Click to select these options in the table">
      <div class="trade-description">
        <strong>${candidate.label}</strong>
        <div class="trade-action">${legsSummary}</div>
        <div class="trade-cost">Cost: ${formatOffsetMoney(candidate.cost)}</div>
        ${conflictNote}
      </div>
      <div class="trade-metrics">
        <div class="trade-potential">Potential: ${formatOffsetMoney(candidate.profitPotential)}</div>
        <div class="trade-locked-profit">Locked: ${formatOffsetMoney(candidate.lockedInProfit)}</div>
        <div class="trade-gap" title="Distance between the existing position's strikes and this candidate's short strike — the zone that has to be closed in to realize the upside above, not just the locked floor">Gap: ${candidate.strikeGapWidth} pts</div>
        <div class="trade-score ${profitClass}">Score: ${(candidate.rankScore * 100).toFixed(1)}%</div>
      </div>
      <button onclick="event.stopPropagation(); ${addFnName}(${index})">Add to calculator</button>
    </div>
  `;
}

function renderOffsetCandidateCards(candidates, selectFnName, addFnName, positionLegs) {
  return candidates.map((c, index) => renderOffsetCandidateCard(c, index, selectFnName, addFnName, positionLegs)).join('');
}

// findAndClickOptionCell dispatches a real click per leg, which toggles that
// cell's entry in selectedTablePositions (oc.js) — so clicking the same card
// twice selects then deselects, matching the table's own toggle behavior.
function selectCandidateLegsInTable(candidate, cardElement) {
  if (!candidate || typeof findAndClickOptionCell !== 'function') return;

  const clickedPositions = candidate.legs
    .map(leg => findAndClickOptionCell(leg.type.toLowerCase(), leg.strike, leg.qty > 0 ? 'ask' : 'bid'))
    .filter(Boolean);

  if (clickedPositions.length > 0 && typeof updateSelectedPositionsDisplay === 'function' && typeof currentOptionsData !== 'undefined') {
    updateSelectedPositionsDisplay(currentOptionsData);
  }

  if (cardElement && typeof selectedTablePositions !== 'undefined') {
    const allLegsSelected = candidate.legs.every(leg => selectedTablePositions.has(`${leg.type.toLowerCase()}${leg.strike}`));
    cardElement.classList.toggle('selected-offset', allLegsSelected);
  }
}
