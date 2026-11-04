import type { WorkflowBatch } from './workflow-types.js';
import type { WorkflowOpinion } from '../data/group-types.js';
import type { WebOpinion, WebOpinionReport } from './web-types.js';
import { currentReference } from './reference.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import { digestOf } from '../data/hash.js';

export function opinionReport(
  batch: WorkflowBatch,
  opinions: readonly WorkflowOpinion[],
): WebOpinionReport {
  const point = batch.points[0];
  if (point?.binding === undefined || point.binding === null)
    throw new Error('unprepared opinion view');
  const binding = point.binding;
  const selected = opinions.filter(
    (opinion) =>
      opinion.pointId === point.pointId &&
      opinion.rootId === point.rootId &&
      opinion.viewId === point.viewId &&
      opinion.annotation !== undefined &&
      sameAnnotationView(opinion.annotation.binding, binding),
  );
  const current = currentReference(
    {
      rootId: point.rootId,
      pointId: point.pointId,
      viewId: point.viewId,
      binding: point.binding,
    },
    [],
    selected,
    point.modelReferenceId,
    batch.batchId,
    point.request,
  );
  const project = (opinion: WorkflowOpinion): WebOpinion => ({
    id: opinion.opinion.reviewId,
    model: `${opinion.opinion.model.provider}/${opinion.opinion.model.id}`,
    rawResponse: opinion.annotation?.rawResponse ?? null,
    rationale: opinion.rationale,
    evidence: opinion.evidence.map((value) => value.ref).join('\n'),
    pairs:
      opinion.annotation?.pairs?.map((pair) => pair.join(',')).join('\n') ?? '',
    behaviour: opinion.independentBehaviour ?? '',
    complete: opinion.annotation?.complete ?? false,
  });
  const reference = current.reference,
    consensus = current.consensus;
  return {
    viewToken: digestOf(batch.batchId),
    opinions: selected.map(project),
    consensus: {
      n: consensus.n,
      k: consensus.k,
      valid: consensus.valid,
      missing: consensus.missing,
      failed: consensus.failed,
      reasons: consensus.reasons,
      draft:
        reference === null
          ? null
          : {
              id: 'model-consensus',
              model: 'model-consensus',
              rawResponse: null,
              rationale: reference.target.rationale,
              evidence: [
                ...new Set(
                  selected
                    .filter((value) =>
                      consensus.supportingOpinionIds.includes(
                        value.opinion.reviewId,
                      ),
                    )
                    .flatMap((value) => value.evidence.map((item) => item.ref)),
                ),
              ].join('\n'),
              pairs:
                reference.target.allowedPairs
                  ?.map((pair) => pair.join(','))
                  .join('\n') ?? '',
              behaviour: reference.target.behaviourReference ?? '',
              complete: true,
            },
    },
  };
}
