import { compileCheckers } from '../data/schemas.js';
import type { WorkflowLabel } from '../data/group-types.js';
import type { HumanBatch, HumanFill, WorkflowBatch } from './workflow-types.js';
import { checked, idSchema } from './workflow-validation.js';
import { responseRedactor } from './workflow-response-redaction.js';

export async function humanBatchFill(value: unknown): Promise<HumanBatch> {
  const fill = checked<HumanBatch>(
    {
      type: 'object',
      additionalProperties: false,
      required: ['batchId', 'decisions'],
      properties: {
        batchId: idSchema,
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['questionId', 'state', 'target'],
            properties: {
              questionId: idSchema,
              state: {
                enum: [
                  'draft',
                  'confirmed',
                  'disputed',
                  'undecidable',
                  'needs-review',
                ],
              },
              target: { type: 'object' },
            },
          },
        },
      },
    },
    value,
  );
  const checkers = await compileCheckers();
  for (const decision of fill.decisions) {
    const checked = checkers.labelTarget(decision.target);
    if (!checked.ok) throw new Error(checked.problems.join('; '));
    if (
      decision.state !== 'draft' &&
      (decision.target.decidedBy.trim() === '' ||
        decision.target.rationale.trim() === '' ||
        decision.target.decidedAt === null)
    )
      throw new Error(
        'explicit human decisions require an author, date and rationale',
      );
  }
  if (
    new Set(fill.decisions.map((value) => value.questionId)).size !==
    fill.decisions.length
  )
    throw new Error('duplicate human decision');
  return fill;
}

export function humanDecisionLabel(
  batch: WorkflowBatch,
  decision: HumanFill,
): WorkflowLabel {
  const point = batch.points.find(
    (point) => point.questionId === decision.questionId,
  );
  if (point?.binding === undefined || point.binding === null)
    throw new Error('unknown/unprepared human question');
  if (
    decision.state === 'confirmed' &&
    (decision.target.status !== 'approved' ||
      decision.target.decidedBy.trim() === '' ||
      decision.target.decidedAt === null)
  )
    throw new Error(
      'human confirmation requires explicit approved target, author and date',
    );
  const confirmed = decision.state === 'confirmed';
  const redactor = responseRedactor(`human:${batch.batchId}`, point.request);
  const target = {
    ...decision.target,
    rationale: redactor.text(decision.target.rationale),
    decidedBy: redactor.text(decision.target.decidedBy),
    ...(decision.target.evidence === undefined
      ? {}
      : {
          evidence: decision.target.evidence.map((evidence) => ({
            ...evidence,
            ref: redactor.text(evidence.ref),
            ...(evidence.note === undefined
              ? {}
              : { note: redactor.text(evidence.note) }),
          })),
        }),
  };
  const referenceId =
    decision.state === 'draft'
      ? `${point.humanReferenceId}-draft`
      : point.humanReferenceId;
  const label: WorkflowLabel = {
    referenceId,
    rootId: point.rootId,
    pointId: point.pointId,
    viewId: point.viewId,
    batchId: batch.batchId,
    source: 'human',
    humanConfirmed: confirmed,
    scoringEligible: confirmed,
    versions: point.binding.versions,
    supportingOpinionIds: [],
    target: confirmed ? target : { ...target, status: 'pending' },
    annotation: { binding: point.binding, humanState: decision.state },
  };
  return label;
}
