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

// Worst case (a min) prints "Unbounded loss" when the position has naked short
// exposure; best case (a max) prints "Unbounded gain" when it has net-long-call
// upside — in both cases the underlying finite number is a sampling-window
// artifact, not a real bound, so we show the flag instead.
function formatWorstCase(value, unboundedLoss) {
  return unboundedLoss ? 'Unbounded loss' : formatOffsetMoney(value);
}
function formatBestCase(value, unboundedGain) {
  return unboundedGain ? 'Unbounded gain' : formatOffsetMoney(value);
}

function renderOffsetCandidateCard(candidate, index, selectFnName, addFnName, positionLegs, extraClass = '') {
  const costLessThanLockedClass = Math.abs(candidate.cost) < candidate.hedgeLocked ? 'cost-less-than-locked' : '';
  const profitClass = candidate.hedgeLocked > 0 ? 'profit-positive' : 'profit-neutral';
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
    <div class="offset-trade ${familyClass} ${weakClass} ${costLessThanLockedClass} ${extraClass}"
         onclick="${selectFnName}(${index}, this)"
         title="Click to select these options in the table">
      <div class="trade-description">
        <strong>${candidate.label}</strong>
        <div class="trade-action">${legsSummary}</div>
        <div class="trade-cost">Cost: ${formatOffsetMoney(candidate.cost)}</div>
        ${conflictNote}
      </div>
      <div class="trade-metrics">
        <div class="trade-locked-profit" title="This hedge trade's own guaranteed worst-case P&L, in isolation">Hedge locked: ${formatWorstCase(candidate.hedgeLocked, candidate.hedgeUnboundedLoss)}</div>
        <div class="trade-potential" title="This hedge trade's own best-case P&L, in isolation">Hedge potential: ${formatBestCase(candidate.hedgePotential, candidate.hedgeUnboundedGain)}</div>
        <div class="trade-portfolio-effect" title="Your whole portfolio's worst/best case after adding this hedge, versus before">
          <div class="portfolio-effect-title">Portfolio with hedge</div>
          <div class="portfolio-effect-row">Worst: ${formatWorstCase(candidate.portfolioLocked, candidate.portfolioUnboundedLoss)} <span class="portfolio-effect-was">(was ${formatWorstCase(candidate.baselineLocked, candidate.baselineUnboundedLoss)})</span></div>
          <div class="portfolio-effect-row">Best: ${formatBestCase(candidate.portfolioPotential, candidate.portfolioUnboundedGain)} <span class="portfolio-effect-was">(was ${formatBestCase(candidate.baselinePotential, candidate.baselineUnboundedGain)})</span></div>
        </div>
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

// The three hedge categories the aggregate portfolio search produces, in fallback
// order. Display order at render time is dynamic (best group first — see below);
// this map only supplies labels.
const HEDGE_GROUPS = {
  'cover':     { label: 'Two-leg covers' },
  'tail-risk': { label: 'Tail-risk hedges' },
  'local-dip': { label: 'Valley hedges' },
};

// Classify a candidate into one of the three groups. tail-risk / local-dip carry
// an explicit `family`; the plain aggregate 2-leg covers carry none (only a
// `strategy` like bull_call_spread), so anything without a recognized family is a
// cover.
function getHedgeGroup(candidate) {
  if (candidate.family === 'tail-risk') return 'tail-risk';
  if (candidate.family === 'local-dip') return 'local-dip';
  return 'cover';
}

// Total number of cards shown across all groups before "show more" is used.
const HEDGE_GROUP_TOTAL_BUDGET = 20;

// Renders the candidates split into per-type sections with headers, instead of one
// flat intermingled list. Assumes `candidates` is already globally ranked (tier /
// rankScore, conflicts last) — so a group's first appearance in that array is also
// its best candidate, which lets us order the sections "best group first" just by
// first-appearance order (no re-sorting). Each card keeps its ORIGINAL index into
// `candidates`, because the select/add click handlers index back into the stored
// flat array.
function renderGroupedOffsetCandidateCards(candidates, selectFnName, addFnName, positionLegs) {
  // Partition, preserving original index and within-group order.
  const groups = new Map(); // key -> [{ candidate, index }]  (insertion order = best-group-first)
  candidates.forEach((candidate, index) => {
    const key = getHedgeGroup(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ candidate, index });
  });

  const activeGroups = [...groups.keys()];
  const n = activeGroups.length;
  if (n === 0) return '';

  // Split the 20-card budget across active groups, giving any remainder to the
  // earliest (best) groups: 1 group -> [20], 2 -> [10,10], 3 -> [7,7,6].
  const base = Math.floor(HEDGE_GROUP_TOTAL_BUDGET / n);
  const remainder = HEDGE_GROUP_TOTAL_BUDGET - base * n;
  const capFor = (groupIndex) => base + (groupIndex < remainder ? 1 : 0);

  return activeGroups.map((key, groupIndex) => {
    const items = groups.get(key);
    const cap = capFor(groupIndex);
    const meta = HEDGE_GROUPS[key] || { label: key };

    const cardsHtml = items.map(({ candidate, index }, i) => {
      // Cards beyond the cap are rendered but hidden until "show more".
      const extraClass = i < cap ? '' : 'hidden-extra';
      return renderOffsetCandidateCard(candidate, index, selectFnName, addFnName, positionLegs, extraClass);
    }).join('');

    const hiddenCount = Math.max(0, items.length - cap);
    const moreBtn = hiddenCount > 0
      ? `<button class="offset-group-more" onclick="toggleHedgeGroupExtra(this)" data-more="${hiddenCount}">Show ${hiddenCount} more</button>`
      : '';

    return `
      <div class="offset-group ${key}" data-group="${key}">
        <div class="offset-group-header">${meta.label} <span class="offset-group-count">(${items.length})</span></div>
        <div class="offset-group-cards">${cardsHtml}</div>
        ${moreBtn}
      </div>
    `;
  }).join('');
}

// Reveals/hides the beyond-cap cards in a group (toggling `.expanded` on the
// section; the CSS hides `.hidden-extra` cards only while not expanded).
function toggleHedgeGroupExtra(button) {
  const group = button.closest('.offset-group');
  if (!group) return;
  const expanded = group.classList.toggle('expanded');
  button.textContent = expanded ? 'Show fewer' : `Show ${button.getAttribute('data-more')} more`;
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
