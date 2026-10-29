/**
 * Time and money: what a run cost, and what nobody knows about that cost.
 *
 * Latency is measured from the record's own timing, which the production adapter wrote
 * from the same clock production logs use. Cost is not measured at all, and this
 * module's job is to keep that visible rather than to fill the column in.
 *
 * The rule is the artifact's own: cost is a status, not a number. The runner does not
 * know a provider's rate card, so `cost.amount` is `null` everywhere and a `0` would
 * read as "this call was free" — a different and false claim. This report therefore
 * publishes the reasons and the per-cell counts, and computes no total. A reader who
 * has a rate card can price the token table themselves; a reader who does not is told
 * plainly that nobody priced it.
 *
 * Tokens and durations are separate tables for the same reason: a cheap model that
 * takes four minutes and an expensive one that takes ten seconds are not comparable on
 * either figure alone.
 */

import type { CellFacts } from './cell.js';
import { compareText, distinct, maxOf, mean, median } from './support.js';
import type { DurationStats, EfficiencySection } from './types.js';

/** The duration statistics of one population. */
export function durationStatsOf(cells: readonly CellFacts[]): DurationStats {
  const values = cells
    .filter((cell) => cell.record !== null)
    .map((cell) => cell.durationMs);
  let total = 0;
  for (const value of values) total += value;
  return {
    cells: values.length,
    totalMs: total,
    meanMs: mean(values),
    medianMs: median(values),
    maxMs: maxOf(values),
  };
}

/** One group's duration statistics, sorted by key. */
function byKey(
  cells: readonly CellFacts[],
  keyOf: (cell: CellFacts) => string,
): readonly { readonly key: string; readonly duration: DurationStats }[] {
  const groups = new Map<string, CellFacts[]>();
  for (const cell of cells) {
    const key = keyOf(cell);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [cell]);
    else existing.push(cell);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, group]) => ({ key, duration: durationStatsOf(group) }));
}

/**
 * The one-word cost status of a whole run.
 *
 * A run whose cells all say the same thing reports that thing. A run that mixed
 * `not-computed` and `not-applicable` says `mixed`, because neither word alone would
 * be true of it — and a table that picked one would be quietly wrong about the cells
 * that said the other.
 */
function costStatusOf(
  cells: readonly CellFacts[],
): EfficiencySection['cost']['status'] {
  const statuses = distinct(
    cells
      .map((cell) => cell.costStatus)
      .filter(
        (status): status is 'not-computed' | 'not-applicable' =>
          status !== null,
      ),
  );
  if (statuses.length === 0) return 'none';
  if (statuses.length === 1) {
    return statuses[0] === 'not-applicable' ? 'not-applicable' : 'not-computed';
  }
  return 'mixed';
}

/** Every distinct reason a cell gave for its cost status, in code-point order. */
function costReasonsOf(cells: readonly CellFacts[]): readonly string[] {
  return distinct(
    cells
      .map((cell) => cell.costReason)
      .filter((reason): reason is string => reason !== null),
  );
}

/**
 * Build the efficiency section.
 *
 * There is no `totalCost` member because there is no total to publish: the amount is
 * `null` by contract, and adding a field that could hold a number would invite exactly
 * the zero this milestone forbids.
 */
export function efficiencySection(
  cells: readonly CellFacts[],
): EfficiencySection {
  return {
    duration: durationStatsOf(cells),
    byTarget: byKey(cells, (cell) => cell.targetId),
    byProtocol: byKey(cells, (cell) => cell.protocol),
    cost: {
      status: costStatusOf(cells),
      amount: null,
      currency: null,
      cells: cells.filter((cell) => cell.record !== null).length,
      reasons: costReasonsOf(cells),
    },
  };
}
