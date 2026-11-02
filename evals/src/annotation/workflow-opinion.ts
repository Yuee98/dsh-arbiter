/** Preserve every returned attempt; validation never invents a missing answer. */
import { digestOf } from '../data/hash.js';
import type { WorkflowOpinion } from '../data/group-types.js';
import type { IndependentAnswer } from '../data/annotation-types.js';
import type {
  AnnotationPoint,
  RegisteredModel,
  ReturnedResponse,
  WorkflowBatch,
} from './workflow-types.js';
import { independentAnswer } from './workflow-validation.js';
import { validEvidence } from './workflow-evidence.js';
import { responseRedactor } from './workflow-response-redaction.js';

export function responseOpinion(
  batch: WorkflowBatch,
  point: AnnotationPoint,
  model: RegisteredModel,
  response: ReturnedResponse,
  registration = false,
): WorkflowOpinion {
  if (point.binding === null)
    throw new Error(
      'cannot attach an opinion to a failed material preparation',
    );
  const redactor = responseRedactor(
    `annotation:${batch.batchId}`,
    point.request,
  );
  const rawResponse =
    response.rawResponse === null ? null : redactor.text(response.rawResponse);
  let parsed: unknown = null;
  let answer: IndependentAnswer | null = null;
  const problems: string[] = [];
  let parseFailed = false;
  if (rawResponse !== null) {
    try {
      const text = rawResponse
        .trim()
        .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1');
      parsed = JSON.parse(text);
      answer = independentAnswer(parsed);
    } catch (error) {
      parseFailed = parsed === null;
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (answer !== null) {
    if (answer.rationale.trim() === '') problems.push('missing rationale');
    if (!validEvidence(answer.evidence, point.request))
      problems.push('evidence is absent or not reachable in the actual view');
  }
  const complete =
    answer !== null &&
    answer.pairs !== null &&
    answer.behaviourReference !== null &&
    problems.length === 0;
  const pair = answer?.pairs?.length === 1 ? answer.pairs[0] : undefined;
  const error = response.error === null ? null : redactor.text(response.error);
  const failed = error !== null || parseFailed;
  const outcome =
    rawResponse === null && error === null
      ? 'missing'
      : failed
        ? 'failed'
        : pair !== undefined && answer?.behaviourReference !== null
          ? 'answered'
          : 'partial';
  const scores =
    failed || pair === undefined
      ? { risk: null, authorization: null }
      : { risk: pair[0], authorization: pair[1] };
  return {
    rootId: point.rootId,
    pointId: point.pointId,
    viewId: point.viewId,
    batchId: batch.batchId,
    outcome,
    opinion: {
      reviewId: response.responseId,
      model: model.model,
      protocol: batch.context.protocol,
      ...scores,
      recordedAt: new Date().toISOString().slice(0, 10),
    },
    independentBehaviour: failed ? null : (answer?.behaviourReference ?? null),
    responseRef:
      rawResponse === null
        ? null
        : `opinion:${response.responseId}#annotation/rawResponse`,
    rationale: answer?.rationale ?? null,
    evidence: (answer?.evidence ?? []).map((ref) => ({
      kind: 'material-quote',
      ref,
    })),
    ...(failed ? { error: error ?? problems.join('; ') } : {}),
    annotation: {
      binding: point.binding,
      modelKey: model.modelKey,
      aliases: model.aliases,
      registration,
      rawResponse,
      parsed,
      returned: redactor.value(response),
      parameters: redactor.value(model.parameters),
      pairs: answer?.pairs ?? null,
      conflicts: answer?.conflicts ?? [],
      problems,
      complete: complete && !failed,
      sourceCommit: batch.sourceCommit,
      context: batch.context,
      recordedOrder: 0,
      responseHash: digestOf(response),
    },
  };
}
export function registrationOpinions(
  batch: WorkflowBatch,
): readonly WorkflowOpinion[] {
  return batch.points.flatMap((point) =>
    point.binding === null
      ? []
      : point.registrations.map((registration) => {
          const model = batch.models.find(
            (model) => model.modelKey === registration.modelKey,
          );
          if (model === undefined)
            throw new Error('batch registration has no model');
          return responseOpinion(
            batch,
            point,
            model,
            {
              responseId: registration.reviewId,
              questionId: point.questionId,
              modelKey: model.modelKey,
              rawResponse: null,
              error: null,
            },
            true,
          );
        }),
  );
}
