/**
 * When a label may count, and what the numbers in it are made of.
 *
 * The rule the dataset depends on is short: a label counts as gold only when the
 * user approved it, the case's input still hashes to the value the label recorded,
 * and the label was made under the versions still in force. Everything else is
 * kept and reported with its reason, because a stale or disputed label is real
 * information — it just must not enter a headline metric.
 *
 * Nothing here compares a label with a model's opinion. The human reference is
 * the answer and the engine is the thing being measured, so an engine that
 * disagrees with a label is a finding, never a reason to change the label.
 */

import { verdictFor } from '../../../src/review-contract/matrix.js';
import type { ReviewVerdict } from '../../../src/types.js';

import { digestOf } from './hash.js';
import type { Sourced } from './read.js';
import type {
  AllowedScores,
  BehaviourReference,
  DatasetManifest,
  LabelVersions,
  ReviewCase,
  ReviewInput,
  ReviewLabel,
  ScorePair,
} from './types.js';

/** Why a label is not gold. Each reason stands on its own. */
export type ExclusionReason =
  | 'case-missing'
  | 'input-changed'
  | 'version-drift'
  | 'not-approved'
  | 'indeterminate';

/** One label and why it does or does not count. */
export interface LabelAssessment {
  readonly label: ReviewLabel;
  readonly path: string;
  readonly reasons: readonly ExclusionReason[];
}

/** The hash that binds a label to the input it judged. */
export function inputHashOf(input: ReviewInput): string {
  return digestOf(input);
}

/** Whether a version triple still matches the one in force. */
export function versionsMatch(
  left: LabelVersions,
  right: LabelVersions,
): boolean {
  return (
    left.contract === right.contract &&
    left.rubric === right.rubric &&
    left.policy === right.policy
  );
}

/**
 * Every legal pair a label names, or null when it names no well-formed set.
 *
 * The two fields are stated separately because an adjudicator thinks per field,
 * but a metric consumes a pair. A set with more than one value in either field is
 * therefore required to enumerate its pairs: reading the sets as their product
 * would invent combinations the adjudicator rejected, and there is no arithmetic
 * shortcut that recovers the ones they meant.
 */
export function legalPairs(label: ReviewLabel): readonly ScorePair[] | null {
  const { allowed, allowedPairs } = label.target;
  if (allowed.risk === null || allowed.authorization === null) return null;
  if (allowedPairs !== undefined && allowedPairs.length > 0)
    return allowedPairs;
  const [risk] = allowed.risk;
  const [authorization] = allowed.authorization;
  if (allowed.risk.length !== 1 || allowed.authorization.length !== 1)
    return null;
  if (risk === undefined || authorization === undefined) return null;
  return [[risk, authorization]];
}

/** The number of pairs the two sets would produce if multiplied out. */
export function productSize(allowed: AllowedScores): number {
  return (allowed.risk?.length ?? 0) * (allowed.authorization?.length ?? 0);
}

/** Whether an approved label states a usable decision at all. */
export function isIndeterminate(label: ReviewLabel): boolean {
  if (label.target.behaviourReference === null) return true;
  return legalPairs(label) === null;
}

/**
 * Whether the recorded stage is one the allowed pairs actually reach.
 *
 * A label records both the scores it allows and the stage those scores should
 * produce. Keeping them consistent matters because the two answer different
 * questions: the pairs say how a metric compares a model, and the stage says what
 * the host should do. A label whose pairs reach deny and allow while it records
 * escalate describes two different decisions, so it is reported rather than
 * resolved by preferring one of them.
 */
export function unreachedBehaviour(label: ReviewLabel): boolean {
  const pairs = legalPairs(label);
  const reference = label.target.behaviourReference;
  if (pairs === null || reference === null) return false;
  const reached = matrixBehaviours(pairs).map((entry) => entry.behaviour);
  return !reached.includes(reference);
}

/** Why one label cannot be gold, in the order a reader most wants them. */
export function exclusionReasons(
  label: ReviewLabel,
  context: {
    readonly manifest: DatasetManifest | null;
    readonly caseInput: ReviewInput | undefined;
  },
): readonly ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (context.caseInput === undefined) {
    reasons.push('case-missing');
  } else if (inputHashOf(context.caseInput) !== label.inputHash) {
    reasons.push('input-changed');
  }
  if (
    context.manifest !== null &&
    !versionsMatch(label.versions, context.manifest.versions)
  ) {
    reasons.push('version-drift');
  }
  if (label.target.status !== 'approved') reasons.push('not-approved');
  else if (isIndeterminate(label) || unreachedBehaviour(label))
    reasons.push('indeterminate');
  return reasons;
}

/** One dataset's labels, split into what counts and what does not. */
export interface GoldStatus {
  readonly gold: readonly LabelAssessment[];
  readonly excluded: readonly LabelAssessment[];
}

/** Assess every label against the cases it claims to judge. */
export function assessLabels(
  cases: readonly Sourced<ReviewCase>[],
  labels: readonly Sourced<ReviewLabel>[],
  manifest: DatasetManifest | null,
): GoldStatus {
  const caseById = new Map(
    cases.map((entry) => [entry.document.caseId, entry.document] as const),
  );
  const gold: LabelAssessment[] = [];
  const excluded: LabelAssessment[] = [];
  for (const entry of labels) {
    const target = caseById.get(entry.document.caseId);
    const reasons = exclusionReasons(entry.document, {
      manifest,
      caseInput: target?.input,
    });
    const assessment: LabelAssessment = {
      label: entry.document,
      path: entry.path,
      reasons,
    };
    (reasons.length === 0 ? gold : excluded).push(assessment);
  }
  return { gold, excluded };
}

/**
 * The behaviour a review verdict asks for, as a label records it.
 *
 * A label records the *stage* the review reaches, not the settlement: whether an
 * escalation becomes a human question or a fallback denial depends on the host's
 * ask mode and its real approval channel, which are properties of a run rather
 * than of the case. Keeping the stage here means a label stays valid when the same
 * case is later run under the other mode.
 */
export function behaviourOf(verdict: ReviewVerdict): BehaviourReference {
  switch (verdict) {
    case 'review-allow':
      return 'allow';
    case 'review-deny':
      return 'deny';
    case 'review-escalate':
      return 'escalate';
  }
}

/** The behaviour each legal pair reaches under the shared matrix. */
export function matrixBehaviours(pairs: readonly ScorePair[]): readonly {
  readonly pair: ScorePair;
  readonly behaviour: BehaviourReference;
}[] {
  return pairs.map((pair) => ({
    pair,
    behaviour: behaviourOf(verdictFor(pair[0], pair[1])),
  }));
}
