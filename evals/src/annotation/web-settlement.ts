import type { HumanBatch, WorkflowBatch } from './workflow-types.js';
import { humanBatchFill, humanDecisionLabel } from './workflow-human-label.js';
import { changeWorkflowGroup, workflowRecords } from './workflow-store.js';
import { checkpointWorkflowBatch } from './workflow-service.js';
import { canonicalJson } from '../data/hash.js';

/** Readback under the shared group claim; this operation never changes labels. */
export async function settleHumanIntent(
  path: string,
  batch: WorkflowBatch,
  intent: HumanBatch,
) {
  const fill = await humanBatchFill(intent),
    decision = fill.decisions[0];
  if (
    fill.batchId !== batch.batchId ||
    fill.decisions.length !== 1 ||
    decision === undefined ||
    decision.questionId !== batch.points[0]?.questionId ||
    decision.state === 'draft'
  )
    throw new Error('invalid pending web intent');
  const desired = humanDecisionLabel(batch, decision);
  const observed = await changeWorkflowGroup(
    batch.dataset,
    batch.split,
    batch.group,
    true,
    (state) => {
      const now = workflowRecords(state);
      return {
        labels: now.labels,
        opinions: now.opinions,
        result: {
          labels: now.labels,
          published:
            canonicalJson(
              now.labels.find(
                (label) => label.referenceId === desired.referenceId,
              ) ?? null,
            ) === canonicalJson(desired),
        },
      };
    },
    true,
  );
  if (observed.published) {
    try {
      await checkpointWorkflowBatch(path, batch, observed.labels, []);
    } catch {
      return { published: true, checkpointed: false, state: decision.state };
    }
  }
  return {
    published: observed.published,
    checkpointed: true,
    state: decision.state,
  };
}
