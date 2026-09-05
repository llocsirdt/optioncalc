'use strict';
/**
 * variant-alias.js — map a RECORDED run's variant name onto the CURRENT canonical roster.
 *
 * The naming convention changed on 2026-09-03 when the width sweep landed. Runs recorded before that
 * carry names that no longer exist in the roster, so the comparison grid (keyed `family-column`, e.g.
 * `v6-20`) finds nothing for them and those days render empty even though we have the data:
 *
 *   v0 … v9            (2026-08-20 … 2026-09-02)  pre-width naming — one width per family
 *   vN-W-10k           (2026-09-02 … 2026-09-04)  the retired tight-cap twins
 *   v6-recap-paper, v9-40-paper                   paper fill studies
 *
 * Adding the legacy names to the grid instead would break the backtest overlay, which keys the replay
 * bundle off the CURRENT names — hence aliasing forward rather than back.
 *
 * THE WIDTH IS READ FROM THE RUN'S OWN RECORDED CONFIG (`config.spreadWidth`), never inferred from the
 * name or assumed. Every legacy `vN` happens to be a $20 run, but that is something the data says, not
 * something this module presumes — a $40 legacy run would map to `vN-40` automatically.
 *
 * AN ALIAS IS NOT AN EQUALITY. A `-10k` run really did trade a different loss cap and a `-paper` run a
 * different fill model; they are being shown in the nearest slot, not claimed to BE that variant. Every
 * aliased result therefore carries `aliasOf` (what was actually recorded) and `aliasNote` (what differs),
 * and callers are expected to surface it rather than pass it off as a native run.
 */

// How far a recorded name sits from the canonical config it is being mapped onto. Lower = closer.
// Used both to describe the difference and to break ties when several legacy runs land in one slot.
const KINDS = [
  { test: /^v\d+$/,          rank: 1, note: 'pre-width naming (this family ran a single width)' },
  { test: /^v\d+-\d+-10k$/,  rank: 2, note: 'retired $10k-cap twin — same signal and width, tighter cap' },
  { test: /-paper$/,         rank: 3, note: 'paper fill study — same signal, different fill model' },
];

function kindOf(name) {
  for (const k of KINDS) if (k.test.test(name)) return k;
  return { rank: 4, note: 'retired variant' };
}

/**
 * @param {object} config   the run's recorded `config` block
 * @param {Set<string>} roster  current canonical variant names
 * @returns {null | {variant, exact, aliasOf?, aliasNote?, rank?}}
 *   null when nothing in the roster is a reasonable home for it.
 */
function canonicalFor(config, roster) {
  const recorded = config && config.variant;
  if (!recorded) return null;
  if (roster.has(recorded)) return { variant: recorded, exact: true };

  const fam = /^(v\d+)/.exec(recorded);
  const width = config.spreadWidth;
  if (!fam || !(width > 0)) return null;

  // Preserve a centred-ATM geometry if the recorded run had one — it is a different column, not a
  // different family, and collapsing it into the short-ATM cell would misfile the run.
  // Match the marker ANYWHERE, not just as a suffix — a legacy name can carry a trailing qualifier
  // (`…-cATM-paper`), and dropping the geometry would file the run under one it never traded.
  const centred = /-cATM(?:-|$)/.test(recorded) ? '-cATM' : '';
  const candidate = `${fam[1]}-${width}${centred}`;
  if (!roster.has(candidate)) return null;

  const k = kindOf(recorded);
  return { variant: candidate, exact: false, aliasOf: recorded, aliasNote: k.note, rank: k.rank };
}

/**
 * Resolve a whole set of runs for one (symbol, date) onto the roster, one run per canonical slot.
 *
 * A native run ALWAYS wins its slot — on 2026-09-03/04 both `v6-20` and `v6-20-10k` exist, and the real
 * `v6-20` is the one that belongs there. Among competing aliases the closest config wins (bare name over
 * `-10k` over `-paper`), and equal-rank ties go to the more complete record, so the choice is stable
 * rather than dependent on directory order.
 *
 * @param {Array<{runId, config, eventCount}>} runs
 * @returns {Map<string, object>} canonical variant -> the winning run (annotated)
 */
function resolveSlots(runs, roster) {
  const bySlot = new Map();
  for (const r of runs) {
    const c = canonicalFor(r.config, roster);
    if (!c) continue;
    const cand = { ...r, ...c, rank: c.exact ? 0 : c.rank };
    const held = bySlot.get(c.variant);
    if (!held
      || cand.rank < held.rank
      || (cand.rank === held.rank && (cand.eventCount || 0) > (held.eventCount || 0))) {
      bySlot.set(c.variant, cand);
    }
  }
  return bySlot;
}

module.exports = { canonicalFor, resolveSlots };
