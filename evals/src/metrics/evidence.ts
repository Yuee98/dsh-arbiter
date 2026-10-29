/**
 * Per-example evidence: the table the summary's every figure can be traced back to.
 *
 * A report that prints only rates cannot be checked. So every cell gets a row that
 * carries its own inputs — the input hash the label was approved against, the case
 * file, the label file — its answer, the reference, the class it fell into, and what
 * the host would have done. A reader who disagrees with a classification can see
 * exactly which cell produced it and why.
 *
 * Two rules govern the rows:
 *
 *   - the engine's answer and the human reference sit in separate members and are
 *     never merged. The engine's score is what is being measured; the reference is what
 *     it is measured against. A single "final answer" column would let a reader forget
 *     which one the report trusts.
 *   - a row exists for every planned cell, including the ones that never ran. Their
 *     absence from a table is what makes a small denominator look complete.
 *
 * The differences list is derived from the same rows, so there is one source of truth
 * for both the summary and the per-example detail.
 */

import type { CellFacts } from './cell.js';
import { classifyCell, isError } from './behaviour.js';
import { settlementOf } from './settlement.js';
import { compareText } from './support.js';
import type { AskPolicy } from '../../../src/review-contract/matrix.js';
import type { BehaviourClass, CellView, DifferenceRow } from './types.js';
import { isPublicScore } from '../../../src/review-contract/rubrics.js';

/** The reason a cell was classified as it was, in a sentence. */
function detailOf(cell: CellFacts, classification: BehaviourClass): string {
  const observed = cell.engineWord ?? '（无判定）';
  const expected = cell.reference ?? '（无参考）';
  if (classification === 'technical') {
    return `引擎没有给出可比较的判定：${cell.engine.reason ?? '未知原因'}`;
  }
  if (classification === 'missing-record') {
    return '索引声称该格子已派发，但运行目录里没有它的记录。';
  }
  if (classification === 'not-run') {
    return `该格子在派发前就已决定为 ${cell.indexStatus}，从未发出请求。`;
  }
  if (classification === 'uncompared') {
    return `引擎给出 ${observed}，但该案例没有可计入金标的参考。`;
  }
  return `引擎给出 ${observed}，参考要求 ${expected}。`;
}

/** One row of the per-example table. */
export function cellViewOf(parts: {
  readonly cell: CellFacts;
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
}): CellView {
  const cell = parts.cell;
  const classification = classifyCell(cell);
  return {
    cellId: cell.cellId,
    caseId: cell.caseId,
    familyId: cell.caseFacts?.familyId ?? 'unknown',
    split: cell.caseFacts?.split ?? 'unknown',
    provenance: cell.caseFacts?.provenance ?? 'unknown',
    challenge: cell.caseFacts?.challenge ?? [],
    challengeClass: cell.challengeClass,
    targetId: cell.targetId,
    provider: cell.model?.provider ?? '',
    model: cell.model?.configured ?? '',
    modelVersion: cell.model?.version ?? null,
    protocol: cell.protocol,
    repeat: cell.repeat,
    origin: cell.repeat > 1 ? 'repeat' : 'original',
    status: cell.indexStatus,
    outcomeStatus: cell.record?.outcome?.status ?? null,
    engine: cell.engine,
    reference: cell.reference,
    labelStatus: cell.labelStatus,
    labelReasons: cell.labelReasons,
    labelVersions: cell.label?.label.versions ?? null,
    classification,
    settlement: settlementOf({
      cell,
      mode: parts.mode,
      channel: parts.channel,
    }),
    inputHash: cell.inputHash ?? '',
    casePath: cell.caseFacts?.path ?? null,
    caseFactsSource: cell.caseFacts?.source ?? null,
    caseFactsConflict: cell.caseFacts?.conflictsWithDataset ?? false,
    labelPath: cell.label?.path ?? null,
    reason: cell.engine.reason,
    rationale: cell.label?.label.target.rationale ?? null,
    attempts: cell.record?.attempts.length ?? 0,
    durationMs: cell.durationMs,
    tokens: cell.tokens,
    costStatus: cell.costStatus,
  };
}

/** Every cell's row, in cell-id order so two rebuilds print the same table. */
export function cellViewsOf(parts: {
  readonly cells: readonly CellFacts[];
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
}): readonly CellView[] {
  return parts.cells
    .map((cell) =>
      cellViewOf({ cell, mode: parts.mode, channel: parts.channel }),
    )
    .sort((left, right) => compareText(left.cellId, right.cellId));
}

/** The differences a behaviour row and its reference represent. */
function behaviourDifferences(
  cell: CellFacts,
  classification: BehaviourClass,
): readonly DifferenceRow[] {
  // Only the classes that are an error about the reviewed call produce a row. A
  // technical outcome is reported by the coverage table and the per-cell evidence; a
  // missing record and a pre-dispatch refusal are artifact facts rather than
  // disagreements with the reference.
  if (!isError(classification)) return [];
  return [
    {
      kind: 'behaviour',
      cellId: cell.cellId,
      caseId: cell.caseId,
      observed: cell.engineWord ?? '（无判定）',
      expected: cell.reference ?? '（无参考）',
      detail: detailOf(cell, classification),
    },
  ];
}

/**
 * The score differences of one cell.
 *
 * Separate from the behaviour rows because a cell can reach the right verdict with
 * wrong bands, and that is a calibration finding rather than a quality failure. Both
 * are listed, each under its own kind, so a reader can filter to the one they are
 * working on.
 */
function scoreDifferences(cell: CellFacts): readonly DifferenceRow[] {
  if (!cell.judged || cell.label === null || !cell.label.gold) return [];
  const reference = cell.label.label.target.allowed;
  const rows: DifferenceRow[] = [];
  const fields = [
    { name: 'risk', observed: cell.engine.risk, allowed: reference.risk },
    {
      name: 'authorization',
      observed: cell.engine.authorization,
      allowed: reference.authorization,
    },
  ] as const;
  for (const field of fields) {
    if (field.observed === null || field.allowed === null) continue;
    if (!isPublicScore(field.observed)) continue;
    if (field.allowed.includes(field.observed)) continue;
    rows.push({
      kind: 'score',
      cellId: cell.cellId,
      caseId: cell.caseId,
      observed: `${field.name} ${String(field.observed)}`,
      expected: `${field.name} ${field.allowed.join('/')}`,
      detail: `${field.name} 落在裁决者允许集合之外。`,
    });
  }
  return rows;
}

/**
 * The label-level differences a run's dataset carries.
 *
 * These are about the dataset rather than about this run: a label whose input no
 * longer matches, a disputed decision, or a model opinion recorded for a case with no
 * adjudication. They are listed because a reader comparing the run's numbers with a
 * published dataset needs to know the reference itself has open items.
 */
export function labelFindingsOf(parts: {
  readonly cells: readonly CellFacts[];
  readonly datasetNotes: readonly string[];
}): readonly DifferenceRow[] {
  const rows: DifferenceRow[] = [];
  const seen = new Set<string>();
  for (const cell of parts.cells) {
    if (seen.has(cell.caseId)) continue;
    if (cell.label === null) continue;
    if (cell.label.gold) continue;
    seen.add(cell.caseId);
    rows.push({
      kind: 'label',
      cellId: cell.cellId,
      caseId: cell.caseId,
      observed: `status ${cell.label.label.target.status}`,
      expected: 'approved',
      detail: `这条标签不能计入金标：${cell.label.reasons.join(', ')}`,
    });
  }
  for (const note of parts.datasetNotes) {
    rows.push({
      kind: 'label',
      cellId: '',
      caseId: '',
      observed: 'dataset',
      expected: 'consistent',
      detail: note,
    });
  }
  return rows.sort(
    (left, right) =>
      compareText(left.kind, right.kind) ||
      compareText(left.caseId, right.caseId) ||
      compareText(left.detail, right.detail),
  );
}

/** Every difference this report can state, in a stable order. */
export function differencesOf(
  cells: readonly CellFacts[],
): readonly DifferenceRow[] {
  return cells
    .flatMap((cell) => {
      const classification = classifyCell(cell);
      return [
        ...behaviourDifferences(cell, classification),
        ...scoreDifferences(cell),
      ];
    })
    .sort(
      (left, right) =>
        compareText(left.kind, right.kind) ||
        compareText(left.caseId, right.caseId) ||
        compareText(left.cellId, right.cellId),
    );
}
