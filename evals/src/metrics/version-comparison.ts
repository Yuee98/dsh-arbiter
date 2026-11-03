/** Pair actual saved observations without subtracting unrelated report populations. */
import { canonicalJson } from '../data/hash.js';
import { countsOf, isCompared } from './behaviour.js';
import { cellFactsOfRun } from './cell.js';
import type { CellFacts } from './cell.js';
import type { Observation } from './observe.js';
import type { VersionConditions } from './version-conditions.js';
import { firstConditions } from './source.js';
import { targetConditionChanges } from './version-target-conditions.js';
import { compareText, groupBy, rate, tally } from './support.js';
import type { EvaluationReport } from './types.js';
import {
  commonReferenceEqual,
  viewComparability,
  comparisonCell,
  evidenceVerified,
  measurementOf,
} from './version-comparison-cell.js';
import type {
  ComparisonChange,
  ComparisonReason,
  ComparisonRow,
  ComparisonSide,
  ComparisonTransitions,
  VersionComparison,
} from './version-comparison-types.js';

export interface ComparisonInput {
  readonly conditions: VersionConditions;
  readonly datasetInput: string | null;
  readonly commonDatasetInput: string | null;
  readonly original: Observation;
  readonly common: Observation;
  readonly report: EvaluationReport;
  readonly referenceInputs: readonly string[];
  readonly commonReferenceInputs: readonly string[];
}
function pointKey(cell: CellFacts): string {
  const source = cell.source;
  return source.kind === 'legacy'
    ? canonicalJson([
        'legacy-v1',
        cell.caseFacts?.split ?? 'unknown',
        source.caseId,
      ])
    : canonicalJson([
        'workflows-v1',
        source.split,
        source.group,
        source.rootId,
        source.lineageId,
        source.pointId,
        source.viewId,
      ]);
}
function conditionKey(cell: CellFacts): string {
  return canonicalJson([pointKey(cell), cell.targetId, cell.protocol]);
}
function primaryGroups(
  cells: readonly CellFacts[],
): ReadonlyMap<string, readonly CellFacts[]> {
  return new Map(
    [...groupBy(cells, conditionKey)].map(([key, group]) => {
      const first = firstConditions(group)[0];
      return [key, group.filter((cell) => cell.repeat === first?.repeat)];
    }),
  );
}
function sideOf(input: ComparisonInput): ComparisonSide {
  const original = cellFactsOfRun(input.original),
    common = cellFactsOfRun(input.common);
  const byId = new Map(common.map((cell) => [cell.cellId, cell]));
  return {
    conditions: input.conditions,
    datasetInput: input.datasetInput,
    commonDatasetInput: input.commonDatasetInput,
    run: input.report.run,
    referenceInputs: input.referenceInputs,
    commonReferenceInputs: input.commonReferenceInputs,
    historicalReferences: 'not-established-by-saved-run',
    checks: input.report.checks,
    cellsPlanned: original.length,
    conditionsPlanned: primaryGroups(original).size,
    statuses: tally(original.map((cell) => cell.indexStatus)),
    original: countsOf(original),
    common: countsOf(common),
    cells: original.map((cell) =>
      comparisonCell(
        cell,
        byId.get(cell.cellId) ?? cell,
        input.original.artifact.plan,
      ),
    ),
  };
}
function transition(before: boolean, after: boolean): ComparisonChange {
  return before === after ? 'unchanged' : after ? 'improved' : 'regressed';
}
function conditionsChanged(
  left: CellFacts,
  right: CellFacts,
  baseline: ComparisonInput,
  current: ComparisonInput,
): readonly string[] {
  const changes: string[] = [];
  const before = left.record?.material ?? null,
    after = right.record?.material ?? null;
  if (
    left.inputHash !== null &&
    right.inputHash !== null &&
    left.inputHash !== right.inputHash
  )
    changes.push('source-input');
  if (canonicalJson(baseline.conditions) !== canonicalJson(current.conditions))
    changes.push('policy-or-replay');
  changes.push(
    ...targetConditionChanges(
      left,
      right,
      baseline.original.artifact.plan,
      current.original.artifact.plan,
    ),
  );
  if (
    left.model !== null &&
    right.model !== null &&
    canonicalJson(left.model) !== canonicalJson(right.model)
  )
    changes.push('actual-model');
  if (before !== null && after !== null) {
    if (before.promptFingerprint !== after.promptFingerprint)
      changes.push('rendered-prompt');
    if (
      before.maxInputTokens !== after.maxInputTokens ||
      (before.targetInputTokens !== undefined &&
        after.targetInputTokens !== undefined &&
        before.targetInputTokens !== after.targetInputTokens)
    )
      changes.push('input-budget');
  }
  if (
    canonicalJson(baseline.report.run.candidate ?? null) !==
    canonicalJson(current.report.run.candidate ?? null)
  )
    changes.push('candidate');
  const oldConfig = baseline.report.run.workflowExecution,
    newConfig = current.report.run.workflowExecution;
  if (
    oldConfig !== undefined &&
    newConfig !== undefined &&
    oldConfig.configRevision !== newConfig.configRevision
  )
    changes.push('saved-configuration');
  if (
    left.record !== null &&
    right.record !== null &&
    canonicalJson(left.record.versions) !== canonicalJson(right.record.versions)
  )
    changes.push('versions');
  return changes;
}
function pairedRow(
  key: string,
  left: CellFacts,
  right: CellFacts,
  baseline: ComparisonInput,
  current: ComparisonInput,
): ComparisonRow {
  const reasons: ComparisonReason[] = [];
  if (!evidenceVerified(left) || baseline.conditions.origin === 'unverified')
    reasons.push('baseline-evidence-unverified');
  if (!evidenceVerified(right) || current.conditions.origin === 'unverified')
    reasons.push('current-evidence-unverified');
  const view = viewComparability(left, right);
  if (view === 'different') reasons.push('input-changed');
  else if (view === 'unverified') reasons.push('input-view-unverified');
  if (
    left.evaluationReference.source === 'unresolved' ||
    right.evaluationReference.source === 'unresolved'
  )
    reasons.push('common-reference-unavailable');
  const applicable = reasons.length === 0;
  const a = measurementOf(left),
    b = measurementOf(right);
  const behaviourReference = commonReferenceEqual(left, right, 'behaviour');
  const scoringReference = commonReferenceEqual(left, right, 'scoring');
  const behaviour =
    applicable &&
    behaviourReference &&
    isCompared(a.classification) &&
    isCompared(b.classification);
  const scoring =
    applicable && scoringReference && a.pairHit !== null && b.pairHit !== null;
  if (
    applicable &&
    a.behaviourEligible &&
    b.behaviourEligible &&
    !behaviourReference
  )
    reasons.push('behaviour-reference-differs');
  if (applicable && a.scoringEligible && b.scoringEligible && !scoringReference)
    reasons.push('scoring-reference-differs');
  if (!behaviour) reasons.push('behaviour-unavailable');
  if (!scoring) reasons.push('scoring-unavailable');
  return {
    key,
    baselineCellId: left.cellId,
    currentCellId: right.cellId,
    reasons,
    behaviourMigration: behaviour
      ? {
          baseline: {
            behaviour: a.behaviour,
            classification: a.classification,
          },
          current: { behaviour: b.behaviour, classification: b.classification },
          changed:
            a.behaviour !== b.behaviour ||
            a.classification !== b.classification,
        }
      : null,
    behaviourChange: behaviour
      ? {
          outcome: transition(
            a.classification === 'matched',
            b.classification === 'matched',
          ),
        }
      : null,
    scoringChange: scoring
      ? { outcome: transition(a.pairHit, b.pairHit) }
      : null,
    conditionChanges: conditionsChanged(left, right, baseline, current),
  };
}
function summary(
  rows: readonly ComparisonRow[],
  baseline: ComparisonSide,
  current: ComparisonSide,
  metric: 'behaviour' | 'scoring',
): ComparisonTransitions {
  const selected = rows.filter(
    (row) =>
      (metric === 'behaviour' ? row.behaviourChange : row.scoringChange) !==
      null,
  );
  const before = new Map(
    baseline.cells.map((cell) => [cell.cellId, cell.common]),
  );
  const after = new Map(
    current.cells.map((cell) => [cell.cellId, cell.common]),
  );
  const matched = (
    measurement: ReturnType<typeof measurementOf> | undefined,
  ) =>
    metric === 'behaviour'
      ? measurement?.classification === 'matched'
      : measurement?.pairHit === true;
  const baselineMatched = selected.filter(
    (row) =>
      row.baselineCellId !== null && matched(before.get(row.baselineCellId)),
  ).length;
  const currentMatched = selected.filter(
    (row) =>
      row.currentCellId !== null && matched(after.get(row.currentCellId)),
  ).length;
  const count = (change: ComparisonChange) =>
    selected.filter(
      (row) =>
        (metric === 'behaviour'
          ? row.behaviourChange?.outcome
          : row.scoringChange?.outcome) === change,
    ).length;
  return {
    paired: selected.length,
    baselineMatched,
    currentMatched,
    improved: count('improved'),
    regressed: count('regressed'),
    unchanged: count('unchanged'),
    baselineRate: rate(baselineMatched, selected.length),
    currentRate: rate(currentMatched, selected.length),
  };
}
export function versionComparison(
  baseline: ComparisonInput,
  current: ComparisonInput,
): VersionComparison {
  const before = primaryGroups(cellFactsOfRun(baseline.common));
  const after = primaryGroups(cellFactsOfRun(current.common));
  const rows: ComparisonRow[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(
    compareText,
  )) {
    const a = before.get(key) ?? [],
      b = after.get(key) ?? [];
    const left = a[0],
      right = b[0];
    if (
      a.length !== 1 ||
      b.length !== 1 ||
      left === undefined ||
      right === undefined
    ) {
      rows.push({
        key,
        baselineCellId: left?.cellId ?? null,
        currentCellId: right?.cellId ?? null,
        reasons: [
          a.length > 1 || b.length > 1
            ? 'ambiguous-condition'
            : left === undefined
              ? 'current-only'
              : 'baseline-only',
        ],
        behaviourChange: null,
        behaviourMigration: null,
        scoringChange: null,
        conditionChanges: [],
      });
    } else rows.push(pairedRow(key, left, right, baseline, current));
  }
  const baselineSide = sideOf(baseline),
    currentSide = sideOf(current);
  const paired = rows.filter(
    (row) => row.behaviourChange !== null || row.scoringChange !== null,
  );
  return {
    conditionSelection: 'lowest-planned-repeat',
    interpretation: 'paired-system-observations',
    baseline: baselineSide,
    current: currentSide,
    unionConditions: rows.length,
    pairedConditions: paired.length,
    pairedPoints: new Set(
      paired.map((row) => {
        const cell = before.get(row.key)?.[0];
        return cell === undefined ? row.key : pointKey(cell);
      }),
    ).size,
    behaviour: summary(rows, baselineSide, currentSide, 'behaviour'),
    scoring: summary(rows, baselineSide, currentSide, 'scoring'),
    rows,
  };
}
