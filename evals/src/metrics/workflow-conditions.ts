import type { CellFacts } from './cell.js';
import { sourceOf } from './source.js';
import { compareText, groupBy } from './support.js';

/** A fixed-trajectory observation includes repeat; repairs remain inside their cell. */
export function workflowConditions(
  cells: readonly CellFacts[],
  rootId: string,
): readonly (readonly CellFacts[])[] {
  const selected = cells.filter((cell) => {
    const source = sourceOf(cell);
    return (
      source.kind === 'workflow' &&
      source.rootId === rootId &&
      source.primaryView
    );
  });
  return [
    ...groupBy(selected, (cell) =>
      JSON.stringify([cell.targetId, cell.protocol, cell.repeat]),
    ).entries(),
  ]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, group]) => group);
}

/** Duplicate planned nodes are ambiguous, not a chance to pick the successful answer. */
export function nodeCell(
  cells: readonly CellFacts[],
  pointId: string,
  viewId: string,
): CellFacts | null {
  const selected = cells.filter((cell) => {
    const source = sourceOf(cell);
    return (
      source.kind === 'workflow' &&
      source.pointId === pointId &&
      source.viewId === viewId
    );
  });
  return selected.length === 1 ? (selected[0] ?? null) : null;
}
