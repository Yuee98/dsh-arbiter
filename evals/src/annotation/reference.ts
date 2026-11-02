/** Dynamic references and frozen copies are distinct values. Never consult a score matrix. */
import { sameAnnotationView } from '../data/annotation-binding.js';
import { canonicalJson } from '../data/hash.js';
import type { AnnotationBinding } from '../data/annotation-types.js';
import type { WorkflowLabel, WorkflowOpinion } from '../data/group-types.js';
import { modelConsensus } from './consensus.js';
import type { Consensus } from './consensus.js';

export interface CurrentReference {
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
  readonly binding: AnnotationBinding;
  readonly source: WorkflowLabel['source'];
  readonly humanConfirmed: boolean;
  readonly scoringEligible: boolean;
  readonly reference: WorkflowLabel | null;
  readonly consensus: Consensus;
  readonly reasons: readonly string[];
  readonly staleReferenceIds: readonly string[];
}
export function currentReference(
  identity: {
    readonly rootId: string;
    readonly pointId: string;
    readonly viewId: string;
    readonly binding: AnnotationBinding;
  },
  labels: readonly WorkflowLabel[],
  opinions: readonly WorkflowOpinion[],
  modelReferenceId: string,
  batchId: string,
  request?: unknown,
): CurrentReference {
  const belongs = (value: WorkflowLabel | WorkflowOpinion) =>
    value.rootId === identity.rootId &&
    value.pointId === identity.pointId &&
    value.viewId === identity.viewId;
  const applicable = (value: WorkflowLabel | WorkflowOpinion) =>
    value.annotation !== undefined &&
    sameAnnotationView(value.annotation.binding, identity.binding);
  const relevant = labels.filter(belongs);
  const consensus = modelConsensus(
    opinions.filter((value) => belongs(value) && applicable(value)),
    request,
  );
  const human = relevant.filter(
    (value) =>
      applicable(value) &&
      ['human', 'human-inherited'].includes(value.source) &&
      value.annotation?.humanState !== 'draft' &&
      (value.humanConfirmed ||
        value.target.status === 'disputed' ||
        value.annotation?.humanState !== undefined),
  );
  const direct = human.filter((value) => value.source === 'human');
  const candidates = direct.length > 0 ? direct : human;
  const blocked = candidates.some(
    (value) => !value.humanConfirmed || value.target.status !== 'approved',
  );
  const conflicting =
    new Set(candidates.map((value) => canonicalJson(value.target))).size > 1;
  const base = {
    ...identity,
    consensus,
    staleReferenceIds: relevant
      .filter((value) => !applicable(value))
      .map((value) => value.referenceId),
  };
  if (blocked || conflicting)
    return {
      ...base,
      source: 'unresolved',
      humanConfirmed: false,
      scoringEligible: false,
      reference: null,
      reasons: [
        conflicting ? 'human-reference-conflict' : 'explicit-human-pending',
      ],
    };
  const chosen = candidates[0];
  if (chosen !== undefined)
    return {
      ...base,
      source: chosen.source,
      humanConfirmed: true,
      scoringEligible: chosen.scoringEligible,
      reference: structuredClone(chosen),
      reasons: [],
    };
  if (consensus.pair === null || consensus.behaviour === null)
    return {
      ...base,
      source: 'unresolved',
      humanConfirmed: false,
      scoringEligible: false,
      reference: null,
      reasons: consensus.reasons,
    };
  const pair = consensus.pair;
  const reference: WorkflowLabel = {
    rootId: identity.rootId,
    pointId: identity.pointId,
    viewId: identity.viewId,
    referenceId: modelReferenceId,
    source: 'model-consensus',
    humanConfirmed: false,
    scoringEligible: true,
    versions: identity.binding.versions,
    batchId,
    supportingOpinionIds: consensus.supportingOpinionIds,
    target: {
      status: 'pending',
      allowed: { risk: [pair[0]], authorization: [pair[1]] },
      allowedPairs: [pair],
      behaviourReference: consensus.behaviour,
      rationale: '独立模型暂定共识；仅表示与固定模型参考的一致程度。',
      decidedBy: 'model-consensus',
      decidedAt: null,
    },
    annotation: { binding: identity.binding },
  };
  return {
    ...base,
    source: 'model-consensus',
    humanConfirmed: false,
    scoringEligible: true,
    reference,
    reasons: [],
  };
}
export function freezeReferences<T>(references: T): T {
  return structuredClone(references);
}
