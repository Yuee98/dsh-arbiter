import type { WorkflowBatch } from './workflow-types.js';
import type { WorkflowOpinion } from '../data/group-types.js';
import type { WebOpinion, WebOpinionReport } from './web-types.js';
import { currentReference } from './reference.js';
import { opinionsForView } from './web-consensus.js';
import { digestOf } from '../data/hash.js';

export function opinionReport(
  batch: WorkflowBatch,
  opinions: readonly WorkflowOpinion[],
): WebOpinionReport {
  const point = batch.points[0];
  if (point?.binding === undefined || point.binding === null)
    throw new Error('unprepared opinion view');
  const selected = opinionsForView(opinions, {
    ...point,
    binding: point.binding,
  });
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
  const project = (
    opinion: WorkflowOpinion,
    complete: boolean,
  ): WebOpinion => ({
    id: opinion.opinion.reviewId,
    model: opinion.opinion.model.id,
    rationale: opinion.rationale,
    evidence: opinion.evidence.map((value) => value.ref).join('\n'),
    pairs:
      opinion.annotation?.pairs?.map((pair) => pair.join(',')).join('\n') ?? '',
    behaviour: opinion.independentBehaviour ?? '',
    complete,
    conflicts: opinion.annotation?.conflicts ?? [],
    unresolvedConflicts: opinion.annotation?.unresolvedConflicts ?? [],
  });
  const reference = current.reference,
    consensus = current.consensus;
  const byId = new Map(
    selected.map((opinion) => [opinion.opinion.reviewId, opinion]),
  );
  return {
    viewToken: digestOf(batch.batchId),
    opinions: consensus.participants.flatMap((participant) => {
      const complete = participant.selectedOpinionId !== null;
      const opinion = byId.get(
        participant.selectedOpinionId ??
          participant.attempts.findLast(
            (attempt) =>
              byId.get(attempt.opinionId)?.annotation?.rawResponse != null,
          )?.opinionId ??
          participant.attempts[0]?.opinionId ??
          '',
      );
      return opinion === undefined ? [] : [project(opinion, complete)];
    }),
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
              conflicts: [],
              unresolvedConflicts: [],
            },
    },
  };
}
