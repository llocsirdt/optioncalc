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

// Don't risk more than this share of a hedge's own max value to make the rest
// (e.g. paying $1500 for a $2000-wide spread risks 75% to make 25%).
const MAX_RISK_FRACTION = 0.60;

// Flags a candidate that looks invalid or poor risk/reward, judged on its OWN
// standalone economics (hedgeLocked/hedgePotential, computed for the hedge in
// isolation). Returns { type, note } or null. These are NOT hidden — just marked
// and moved to the bottom, so bad bid/ask data (or lopsided trades) can be spotted
// and confirmed rather than silently trusted.
function getCandidateQualityFlag(candidate) {
  const locked = candidate.hedgeLocked;       // hedge's own worst-case P/L
  const potential = candidate.hedgePotential; // hedge's own best-case P/L
  if (typeof locked !== 'number' || typeof potential !== 'number') return null;

  // Bad data: a standalone hedge that cannot lose is a free-money arbitrage —
  // only possible from crossed/stale quotes (e.g. a credit spread crediting more
  // than its width, which would guarantee a profit).
  if (locked > 0) {
    return { type: 'bad-data', note: '⚠ Invalid: implies risk-free profit (credit exceeds width) — likely bad bid/ask data' };
  }

  // Poor risk/reward: the potential loss is too big a share of the trade's total
  // range (max loss + max profit) — i.e. risking more than MAX_RISK_FRACTION of
  // the spread's value to make the rest.
  const range = potential - locked; // max loss + max profit (= spread width × 100 for a vertical)
  if (range > 0) {
    const riskFraction = (-locked) / range;
    if (riskFraction > MAX_RISK_FRACTION) {
      return {
        type: 'poor-rr',
        note: `⚠ Poor risk/reward: risking ${Math.round(riskFraction * 100)}% to make ${Math.round((1 - riskFraction) * 100)}%`
      };
    }
  }
  return null;
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
  const qualityFlag = getCandidateQualityFlag(candidate);
  const qualityClass = qualityFlag ? 'quality-flagged' : '';
  const qualityNote = qualityFlag
    ? `<div class="trade-flag" title="Marked for review — kept visible but pushed to the bottom of the list">${qualityFlag.note}</div>`
    : '';
  // Strategy type shown in the card's header bar (title-cased from the candidate label).
  const strategyTitle = (candidate.label || candidate.strategy || 'Spread')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  // Simplified legs: strikes in ascending order, a leading "-" on each SHORT leg, no qty/type
  // clutter (e.g. bull call = "29240 / -29260", bear put = "-29220 / 29240"). The option type
  // (C/P) is only appended when a candidate mixes calls and puts (e.g. a tail-risk condor).
  const mixedTypes = new Set(candidate.legs.map(l => (l.type || '').toUpperCase())).size > 1;
  const legsSummary = candidate.legs
    .slice()
    .sort((a, b) => a.strike - b.strike)
    .map(l => `${l.qty < 0 ? '-' : ''}${l.strike}${mixedTypes ? (l.type || '').toUpperCase() : ''}`)
    .join(' / ');
  const conflictNote = hasOppositeLeg
    ? '<div class="trade-conflict" title="One of this trade\'s legs is the opposite direction of the same strike/type already in your position">⚠ Opposes an existing leg</div>'
    : '';

  return `
    <div class="offset-trade offset-trade-carded ${familyClass} ${weakClass} ${costLessThanLockedClass} ${qualityClass} ${extraClass}"
         onclick="${selectFnName}(${index}, this)"
         title="Click to select these options in the table">
      <div class="trade-strategy-header">
        <div class="trade-strategy-type">${strategyTitle}</div>
        <div class="trade-strategy-detail">${legsSummary} &nbsp;·&nbsp; Cost: ${formatOffsetMoney(candidate.cost)}</div>
      </div>
      <div class="trade-body">
      ${(conflictNote || qualityNote) ? `<div class="trade-description">${conflictNote}${qualityNote}</div>` : ''}
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
  // Partition, preserving original index and within-group order. Invalid / poor
  // risk-reward candidates are pulled out into a trailing "Flagged" section
  // instead of a type group, so they sink to the bottom but stay visible.
  const groups = new Map(); // key -> [{ candidate, index }]  (insertion order = best-group-first)
  const flagged = [];       // [{ candidate, index }]
  candidates.forEach((candidate, index) => {
    if (getCandidateQualityFlag(candidate)) {
      flagged.push({ candidate, index });
      return;
    }
    const key = getHedgeGroup(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ candidate, index });
  });

  const activeGroups = [...groups.keys()];
  const n = activeGroups.length;

  let html = '';

  if (n > 0) {
    // Split the 20-card budget across active groups, giving any remainder to the
    // earliest (best) groups: 1 group -> [20], 2 -> [10,10], 3 -> [7,7,6].
    const base = Math.floor(HEDGE_GROUP_TOTAL_BUDGET / n);
    const remainder = HEDGE_GROUP_TOTAL_BUDGET - base * n;
    const capFor = (groupIndex) => base + (groupIndex < remainder ? 1 : 0);

    html += activeGroups.map((key, groupIndex) => {
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

  // Trailing section: flagged candidates, shown in full (not capped) so they can
  // be reviewed. Each already carries a red border + note from the card renderer.
  if (flagged.length > 0) {
    const flaggedCards = flagged
      .map(({ candidate, index }) => renderOffsetCandidateCard(candidate, index, selectFnName, addFnName, positionLegs))
      .join('');
    html += `
      <div class="offset-group flagged-group" data-group="flagged">
        <div class="offset-group-header">⚠ Flagged — review <span class="offset-group-count">(${flagged.length})</span></div>
        <div class="offset-group-cards">${flaggedCards}</div>
      </div>
    `;
  }

  return html;
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
