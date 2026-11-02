/** Reuse the identity-aware material proof without treating reference absence as drift. */
import { observeWorkflow } from '../metrics/workflow-observe.js';
import type { ReadableSource } from './assemble.js';
import type { InputComparison } from './inputs.js';

export async function compareWorkflowInputs(
  root: string,
  source: ReadableSource,
): Promise<InputComparison> {
  try {
    const observation = await observeWorkflow({
      directory: source.directory,
      root,
      datasetPath: source.plan.datasetPath,
      artifact: {
        plan: source.plan,
        index: source.index,
        records: [...source.records.values()].map((entry) => entry.record),
        missing: source.recordless,
      },
      snapshots: [],
    });
    if (observation.problems.length > 0)
      return { status: 'unavailable', reason: observation.problems.join('; ') };
    const unverified = [...observation.cells.entries()].flatMap(
      ([cellId, cell]) =>
        cell.caseFacts === null || cell.caseFacts.conflictsWithDataset
          ? [
              {
                caseId:
                  source.index.cells.find((state) => state.cellId === cellId)
                    ?.caseId ?? cellId,
                reason:
                  'workflow source or submitted material cannot be verified',
              },
            ]
          : [],
    );
    return { status: 'compared', drifted: [], unverified };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
