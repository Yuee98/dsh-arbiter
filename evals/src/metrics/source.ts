/** Report identities are explicit; a runner's compatibility key is never a workflow root. */
import type { CellFacts } from './cell.js';

export type MetricSource =
  | { readonly kind: 'legacy'; readonly caseId: string }
  | {
      readonly kind: 'workflow';
      readonly rootId: string;
      readonly lineageId: string;
      readonly pointId: string;
      readonly viewId: string;
      readonly group: string;
      readonly split: string;
      readonly branchId: string;
      readonly primaryView: boolean;
    };

export function sourceOf(cell: CellFacts): MetricSource {
  return cell.source;
}

export function viewKeyOf(cell: CellFacts): string {
  const source = sourceOf(cell);
  return source.kind === 'legacy'
    ? JSON.stringify(['legacy-v1', source.caseId])
    : JSON.stringify([
        'workflows-v1',
        source.rootId,
        source.pointId,
        source.viewId,
      ]);
}

export function conditionKeyOf(cell: CellFacts): string {
  // One report consumes one frozen run/candidate; candidate boundaries are never pooled here.
  return JSON.stringify([viewKeyOf(cell), cell.targetId, cell.protocol]);
}

/** Lowest planned repeat, including failure: selecting the first success would hide failures. */
export function firstConditions(
  cells: readonly CellFacts[],
): readonly CellFacts[] {
  const kept = new Map<string, CellFacts>();
  for (const cell of cells) {
    const key = conditionKeyOf(cell);
    const previous = kept.get(key);
    if (previous === undefined || cell.repeat < previous.repeat)
      kept.set(key, cell);
  }
  return [...kept.values()];
}
