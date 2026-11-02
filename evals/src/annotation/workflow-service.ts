/** Shared offline operations for CLI and the later human annotation UI. */
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnnotationContext } from '../data/annotation-types.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import { canonicalJson } from '../data/hash.js';
import { compileCheckers } from '../data/schemas.js';
import type { WorkflowLabel, WorkflowOpinion } from '../data/group-types.js';
import type { Split } from '../data/types.js';
import { currentReference, freezeReferences } from './reference.js';
import { responseOpinion, registrationOpinions } from './workflow-opinion.js';
import { readWorkflowBatch } from './workflow-batch-read.js';
import {
  assertLabelBaseline,
  changeWorkflowGroup,
  mergeOpinions,
  readJson,
  workflowRecords,
  workflowState,
} from './workflow-store.js';
import {
  annotationContext,
  buildAnnotationView,
  workflowSource,
} from './workflow-view.js';
import { checked, idSchema, returnedBatch } from './workflow-validation.js';
import type {
  AnnotationPoint,
  HumanBatch,
  WorkflowBatch,
} from './workflow-types.js';
import { annotationOrigin } from './workflow-origin.js';
import { responseRedactor } from './workflow-response-redaction.js';

async function validBatch(
  dataset: string,
  path: string,
  context?: AnnotationContext,
): Promise<WorkflowBatch> {
  const batch = await readWorkflowBatch(path);
  if (resolve(dataset) !== batch.dataset)
    throw new Error('batch belongs to another dataset');
  const source = await workflowSource(dataset, batch.split, batch.group);
  for (const point of batch.points) {
    if (point.binding === null) continue;
    const actual = await buildAnnotationView(
      source,
      point.rootId,
      point.pointId,
      context ?? batch.context,
    );
    if (!sameAnnotationView(point.binding, actual.binding))
      throw new Error(
        `input/view/contract changed for ${point.pointId}; re-export for review`,
      );
  }
  return batch;
}
async function checkpoint(
  path: string,
  before: WorkflowBatch,
  labels: readonly WorkflowLabel[],
  opinions: readonly WorkflowOpinion[],
): Promise<void> {
  if (canonicalJson(await readJson(path)) !== canonicalJson(before))
    throw new Error(
      'data saved, but batch checkpoint changed externally; retry the same return before adding new answers',
    );
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ ...before, labels, opinions }, null, 2) + '\n',
      { flag: 'wx' },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
function unresolvedLabel(
  batch: WorkflowBatch,
  point: AnnotationPoint,
  opinions: readonly WorkflowOpinion[],
  labels: readonly WorkflowLabel[],
): WorkflowLabel {
  if (point.binding === null)
    throw new Error('point has no effective material');
  const current = currentReference(
    {
      rootId: point.rootId,
      pointId: point.pointId,
      viewId: point.viewId,
      binding: point.binding,
    },
    [],
    opinions,
    point.modelReferenceId,
    batch.batchId,
  );
  // Machine cache always stays separate, including when a human decision is effective.
  const model = current.reference;
  if (model !== null) return model;
  const previous = labels.find(
    (value) => value.referenceId === point.modelReferenceId,
  );
  return {
    referenceId: point.modelReferenceId,
    rootId: point.rootId,
    pointId: point.pointId,
    viewId: point.viewId,
    source: 'unresolved',
    humanConfirmed: false,
    scoringEligible: false,
    versions: point.binding.versions,
    batchId: batch.batchId,
    supportingOpinionIds: current.consensus.supportingOpinionIds,
    target: {
      status: 'pending',
      allowed: { risk: null, authorization: null },
      behaviourReference: null,
      rationale: current.reasons.join('; '),
      decidedBy: 'model-consensus',
      decidedAt: null,
    },
    annotation: { binding: point.binding },
    ...(previous?.notes === undefined ? {} : { notes: previous.notes }),
  };
}
export async function importWorkflowOpinions(options: {
  readonly dataset: string;
  readonly baseline: string;
  readonly returned: unknown;
  readonly write: boolean;
  readonly context?: AnnotationContext;
}) {
  const batch = await validBatch(
    options.dataset,
    options.baseline,
    options.context,
  );
  const returned = returnedBatch(options.returned);
  if (returned.batchId !== batch.batchId)
    throw new Error('returned answers belong to another batch');
  const touched = new Set<string>();
  const incoming = returned.responses.map((response) => {
    const point = batch.points.find(
      (point) => point.questionId === response.questionId,
    );
    const model = batch.models.find(
      (model) =>
        model.modelKey === response.modelKey ||
        model.aliases.includes(response.modelKey),
    );
    if (point === undefined || model === undefined)
      throw new Error('returned answer has unknown question/model identity');
    touched.add(point.pointId);
    return responseOpinion(batch, point, model, response);
  });
  if (incoming.length === 0)
    for (const point of batch.points)
      if (point.binding !== null) touched.add(point.pointId);
  const result = await changeWorkflowGroup(
    options.dataset,
    batch.split,
    batch.group,
    options.write,
    async (state) => {
      // Source is rechecked while holding the claim, before any role write.
      await validBatch(options.dataset, options.baseline, options.context);
      const now = workflowRecords(state);
      for (const old of batch.opinions.filter((value) =>
        touched.has(value.pointId),
      )) {
        const actual = now.opinions.find(
          (value) => value.opinion.reviewId === old.opinion.reviewId,
        );
        if (canonicalJson(actual ?? null) !== canonicalJson(old))
          throw new Error(
            `opinion baseline conflict for ${old.opinion.reviewId}`,
          );
      }
      const opinions = mergeOpinions(now.opinions, [
        ...registrationOpinions(batch),
        ...incoming,
      ]);
      const replacements = batch.points
        .filter((point) => touched.has(point.pointId) && point.binding !== null)
        .map((point) => unresolvedLabel(batch, point, opinions, now.labels));
      const ids = new Set(replacements.map((value) => value.referenceId));
      const labels = [
        ...now.labels.filter((value) => !ids.has(value.referenceId)),
        ...replacements,
      ];
      assertLabelBaseline(batch, now.labels, labels, touched);
      return {
        labels,
        opinions,
        result: { labels, opinions, responses: incoming.length },
      };
    },
  );
  if (options.write)
    await checkpoint(options.baseline, batch, result.labels, result.opinions);
  return result;
}
export async function importWorkflowHuman(options: {
  readonly dataset: string;
  readonly baseline: string;
  readonly fill: unknown;
  readonly write: boolean;
}) {
  const batch = await validBatch(options.dataset, options.baseline);
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
    options.fill,
  );
  if (fill.batchId !== batch.batchId)
    throw new Error('human fill belongs to another batch');
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
  const result = await changeWorkflowGroup(
    options.dataset,
    batch.split,
    batch.group,
    options.write,
    async (state) => {
      await validBatch(options.dataset, options.baseline);
      const now = workflowRecords(state);
      const replacements = fill.decisions.map((decision) => {
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
        const redactor = responseRedactor(
          `human:${batch.batchId}`,
          point.request,
        );
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
      });
      const ids = new Set(replacements.map((value) => value.referenceId));
      const labels = [
        ...now.labels.filter((value) => !ids.has(value.referenceId)),
        ...replacements,
      ];
      assertLabelBaseline(
        batch,
        now.labels,
        labels,
        new Set(replacements.map((value) => value.pointId)),
      );
      return {
        labels,
        opinions: now.opinions,
        result: {
          labels,
          opinions: now.opinions,
          decisions: replacements.length,
        },
      };
    },
  );
  if (options.write)
    await checkpoint(options.baseline, batch, result.labels, result.opinions);
  return result;
}
export async function workflowReferences(options: {
  readonly root?: string;
  readonly dataset: string;
  readonly split: Split;
  readonly group: string;
  readonly context: AnnotationContext;
}) {
  const context = annotationContext(options.context);
  const source = await workflowSource(
    options.dataset,
    options.split,
    options.group,
  );
  const records = workflowRecords(
    await workflowState(options.dataset, options.split, options.group),
  );
  const entries = [];
  for (const entry of source.groups.flatMap((group) => group.workflows))
    for (const point of entry.document.points) {
      try {
        const view = await buildAnnotationView(
          source,
          entry.document.rootId,
          point.pointId,
          context,
        );
        const modelId =
          records.labels.find(
            (label) =>
              label.pointId === point.pointId &&
              label.annotation !== undefined &&
              sameAnnotationView(label.annotation.binding, view.binding) &&
              ['model-consensus', 'unresolved'].includes(label.source),
          )?.referenceId ?? point.primaryViewId;
        entries.push({
          ...currentReference(
            {
              rootId: entry.document.rootId,
              pointId: point.pointId,
              viewId: point.primaryViewId,
              binding: view.binding,
            },
            records.labels,
            records.opinions,
            modelId,
            'current-reference',
          ),
          error: null,
          request: view.request,
        });
      } catch (error) {
        entries.push({
          rootId: entry.document.rootId,
          pointId: point.pointId,
          viewId: point.primaryViewId,
          source: 'unresolved',
          humanConfirmed: false,
          scoringEligible: false,
          reference: null,
          consensus: null,
          binding: null,
          reasons: ['material-preparation-failed'],
          staleReferenceIds: [],
          error: error instanceof Error ? error.message : String(error),
          request: null,
        });
      }
    }
  return freezeReferences({
    snapshotVersion: 'workflow-references-v1',
    ...(await annotationOrigin(
      options.root ?? fileURLToPath(new URL('../../../', import.meta.url)),
    )),
    createdAt: new Date().toISOString(),
    scope: { split: options.split, group: options.group },
    context,
    entries,
  });
}
