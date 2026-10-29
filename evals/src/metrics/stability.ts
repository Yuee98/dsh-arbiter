/**
 * Repeat stability, and how many independent samples a run really holds.
 *
 * The milestone's comparison rule is that related variants and repeats are not
 * independent samples. This module is where that rule becomes arithmetic rather than
 * a caveat in prose:
 *
 *   - a repeat is a *separate cell* with the same case, target and protocol. It is a
 *     second observation of one input, so it measures stability and adds no coverage.
 *   - a repair is the transport's own second ask inside one attempt sequence. It is a
 *     real attempt that cost real tokens, but it is not an observation at all.
 *   - a related variant is a different case in the same family. It adds coverage of a
 *     mechanism but shares a seed with its siblings, so the family — not the case — is
 *     the unit the sample count is reported over as well.
 *
 * All three numbers are published together because any one alone is misleading: a run
 * of 51 cells could be 51 cases, one case repeated fifty-one times, or 51 variants of
 * one seed.
 */

import type { CellFacts } from './cell.js';
import { compareText, distinct, groupBy } from './support.js';
import type {
  BehaviourWord,
  RepeatGroup,
  SampleWeights,
  StabilitySection,
} from './types.js';
import type { RunProtocol } from '../run/types.js';

/** Whether a cell's answer is one of the three behaviours. */
function behaviourOf(cell: CellFacts): BehaviourWord | null {
  const word = cell.engineWord;
  return word === 'allow' || word === 'deny' || word === 'escalate'
    ? word
    : null;
}

/** The spread of a list of numbers, or null when nothing was measured. */
function spreadOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values) - Math.min(...values);
}

/** The key a repeat group is identified by. */
function groupKeyOf(cell: CellFacts): string {
  return [cell.caseId, cell.targetId, cell.protocol].join('~');
}

/**
 * One repeat group.
 *
 * Stability is judged on the behaviour word rather than on the exact pair: two answers
 * that differ by one band but reach the same verdict are the same observation for the
 * purpose of "does repeating this change what happens". The score spread is reported
 * beside it so the finer-grained difference is still visible.
 */
function repeatGroupOf(cells: readonly CellFacts[]): RepeatGroup | null {
  const first = cells[0];
  if (first === undefined) return null;
  const ordered = [...cells].sort((left, right) => left.repeat - right.repeat);
  const answers: {
    readonly repeat: number;
    readonly risk: number;
    readonly authorization: number;
    readonly behaviour: BehaviourWord;
  }[] = [];
  for (const cell of ordered) {
    const behaviour = behaviourOf(cell);
    const risk = cell.engine.risk;
    const authorization = cell.engine.authorization;
    if (behaviour === null || risk === null || authorization === null) continue;
    answers.push({ repeat: cell.repeat, risk, authorization, behaviour });
  }
  const behaviours = answers.map((answer) => answer.behaviour);
  return {
    caseId: first.caseId,
    targetId: first.targetId,
    protocol: first.protocol,
    repeats: ordered.length,
    judged: answers.length,
    answers,
    // Fewer than two judged answers is not stability: it is the absence of the comparison
    // the figure is about. A group whose repeats all timed out must not raise the count of
    // groups that held steady.
    stable: answers.length < 2 ? null : new Set(behaviours).size <= 1,
    distinctAnswers: new Set(
      answers.map(
        (answer) => `${String(answer.risk)}/${String(answer.authorization)}`,
      ),
    ).size,
    riskSpread: spreadOf(answers.map((answer) => answer.risk)),
    authorizationSpread: spreadOf(
      answers.map((answer) => answer.authorization),
    ),
  };
}

/**
 * The sample weights of one run.
 *
 * `cells` is what the artifact holds; `distinctCases` is the coverage; `repeats` is how
 * much of the cell count is repetition. A reader who only read the first would believe
 * a repeated case was fifty new samples.
 */
export function sampleWeightsOf(cells: readonly CellFacts[]): SampleWeights {
  const records = cells.filter((cell) => cell.record !== null);
  return {
    cells: cells.length,
    records: records.length,
    distinctCases: distinct(cells.map((cell) => cell.caseId)).length,
    distinctFamilies: distinct(
      cells.map((cell) => cell.caseFacts?.familyId ?? 'unknown'),
    ).length,
    distinctTargets: distinct(cells.map((cell) => cell.targetId)).length,
    distinctProtocols: distinct(cells.map((cell) => cell.protocol)).length,
    repeats: cells.filter((cell) => cell.repeat > 1).length,
    repairs: records.reduce(
      (total, cell) =>
        total +
        (cell.record?.attempts.filter((attempt) => attempt.kind === 'repair')
          .length ?? 0),
      0,
    ),
  };
}

/** Which protocols one run actually used, for a caller that prints the sample table. */
export function protocolsOf(
  cells: readonly CellFacts[],
): readonly RunProtocol[] {
  return distinct(cells.map((cell) => cell.protocol)).filter(
    (value): value is RunProtocol => value === 'chat' || value === 'decision',
  );
}

/**
 * Build the stability section.
 *
 * Groups with one cell are excluded from the repeat table: a case run once has no
 * stability to report, and listing it as "stable" would be a claim about a comparison
 * that never happened. The count of cells with repeats is published so it is clear how
 * much of the run the table speaks for.
 */
export function stabilitySection(
  cells: readonly CellFacts[],
): StabilitySection {
  const groups = [...groupBy(cells, groupKeyOf).values()]
    .map((group) => repeatGroupOf(group))
    .filter((group): group is RepeatGroup => group !== null)
    .filter((group) => group.repeats > 1)
    .sort((left, right) =>
      compareText(
        [left.caseId, left.targetId, left.protocol].join('~'),
        [right.caseId, right.targetId, right.protocol].join('~'),
      ),
    );
  return {
    samples: sampleWeightsOf(cells),
    repeatGroups: groups,
    stableGroups: groups.filter((group) => group.stable === true).length,
    unstableGroups: groups.filter((group) => group.stable === false).length,
    unassessableGroups: groups.filter((group) => group.stable === null).length,
    withRepeats: groups.reduce((total, group) => total + group.repeats, 0),
  };
}
