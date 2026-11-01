import { describe, expect, it } from 'vitest';
import type {
  WorkflowLabel,
  WorkflowOpinion,
} from '../../evals/src/data/group-types.js';
import { selectPointMaterial } from '../../evals/src/data/workflow-material.js';
import { collectionOf, workflow } from './fixtures/workflow.js';
import { approvedTarget, opinion, VERSIONS } from './fixtures/documents.js';
import { loadWorkflow, problemText } from './helpers/grouped.js';

function labelled(): WorkflowLabel {
  return {
    referenceId: 'ref-1',
    rootId: 'format-build',
    pointId: 'format-clean',
    viewId: 'format-clean-main',
    source: 'human',
    humanConfirmed: true,
    scoringEligible: true,
    versions: VERSIONS,
    batchId: 'format-batch',
    supportingOpinionIds: ['review-1'],
    target: approvedTarget({ rationale: 'LABEL_SENTINEL' }),
  };
}
function answered(): WorkflowOpinion {
  return {
    rootId: 'format-build',
    pointId: 'format-clean',
    viewId: 'format-clean-main',
    batchId: 'format-batch',
    outcome: 'answered',
    opinion: opinion({ notes: 'OPINION_SENTINEL' }),
    independentBehaviour: 'allow',
    responseRef: null,
    rationale: null,
    evidence: [],
  };
}
function files(
  label: unknown = labelled(),
  review: unknown = answered(),
): Record<string, unknown> {
  return {
    'dev/f01/labels.json': collectionOf(label),
    'dev/f01/opinions.json': collectionOf(review),
  };
}

describe('reference identity and independent observation boundaries', () => {
  it('loads reference roles separately and never passes them to material', async () => {
    const loaded = await loadWorkflow(workflow(), files());
    expect(loaded.problems).toEqual([]);
    expect(loaded.groups[0]?.labels).toHaveLength(1);
    const text = JSON.stringify(
      selectPointMaterial(loaded, 'format-build', 'format-clean'),
    );
    expect(text).not.toContain('LABEL_SENTINEL');
    expect(text).not.toContain('OPINION_SENTINEL');
    expect(text).not.toContain('referenceId');
  });

  it.each(['rootId', 'pointId', 'viewId'] as const)(
    'rejects wrong %s for both reference roles',
    async (field) => {
      const label = await loadWorkflow(
        workflow(),
        files({ ...labelled(), [field]: 'other' }),
      );
      expect(problemText(label)).toContain('wrong root/point/view binding');
      const review = await loadWorkflow(
        workflow(),
        files(labelled(), { ...answered(), [field]: 'other' }),
      );
      expect(problemText(review)).toContain('wrong root/point/view binding');
    },
  );

  it('keeps missing/failed answers explicitly null, never infers independent behaviour', async () => {
    for (const outcome of ['failed', 'missing'] as const) {
      const review = {
        ...answered(),
        outcome,
        opinion: opinion({ risk: null, authorization: null }),
        independentBehaviour: null,
        ...(outcome === 'failed' ? { error: 'fixture failure' } : {}),
      };
      const loaded = await loadWorkflow(workflow(), files(labelled(), review));
      expect(loaded.problems).toEqual([]);
      expect(loaded.groups[0]?.opinions[0]?.document).toMatchObject({
        outcome,
        independentBehaviour: null,
      });
    }
    const missing = await loadWorkflow(
      workflow(),
      files(labelled(), { ...answered(), outcome: 'missing' }),
    );
    expect(problemText(missing)).toContain('cannot fabricate');
    const unpaired = await loadWorkflow(
      workflow(),
      files(labelled(), { ...answered(), independentBehaviour: null }),
    );
    expect(problemText(unpaired)).toContain('independent behaviour');
  });

  it('rejects duplicate opinions and does not upgrade machine consensus to human confirmation', async () => {
    const duplicate = await loadWorkflow(workflow(), {
      ...files(),
      'dev/f01/opinions.json': collectionOf(answered(), answered()),
    });
    expect(problemText(duplicate)).toContain('duplicate opinion/review-1');
    const machine = await loadWorkflow(
      workflow(),
      files({ ...labelled(), source: 'model-consensus' }),
    );
    expect(problemText(machine)).toContain('human confirmation');
    expect(problemText(machine)).toContain('never human approved');
  });
});
