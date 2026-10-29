/**
 * What a dataset's labels add up to.
 *
 * The counts here are the ones a reader needs to judge whether a headline number
 * means anything: how many labels are gold, how many were excluded and why, how many
 * model opinions were recorded, and where a model disagreed with the human
 * reference. A disagreement is reported and never written back: the human reference
 * is the answer and the engine is the thing being measured.
 *
 * Nothing in this module decides an adjudication, computes a pass or fail, or calls
 * a model. It reads what is committed and reports it.
 */

import { digestOf } from '../data/hash.js';
import { legalPairs, matrixBehaviours } from '../data/eligibility.js';
import type { ExclusionReason } from '../data/eligibility.js';
import type { Finding, DatasetInspection } from '../data/inspect.js';
import type {
  CaseReviews,
  DatasetManifest,
  ModelOpinion,
  ReviewLabel,
  ScorePair,
} from '../data/types.js';

/** Counts per exclusion reason, so a reader can see why labels were dropped. */
export type ExclusionCounts = Readonly<Record<ExclusionReason, number>>;

/** How often one model agreed with the human reference. */
export interface ModelAgreement {
  readonly provider: string;
  readonly id: string;
  readonly compared: number;
  readonly agreed: number;
}

/** One model opinion that reached a different behaviour than the reference. */
export interface Disagreement {
  readonly caseId: string;
  readonly reviewId: string;
  readonly model: string;
  readonly risk: number | null;
  readonly authorization: number | null;
  readonly observed: string;
  readonly reference: string;
}

/** The whole summary of one dataset. */
export interface DatasetSummary {
  readonly datasetId: string | null;
  /** The versions the manifest declares, or null when it did not load. */
  readonly versions: DatasetManifest['versions'] | null;
  readonly totals: {
    readonly cases: number;
    readonly families: number;
    readonly labels: number;
    readonly reviews: number;
  };
  readonly gold: number;
  readonly excluded: number;
  readonly exclusions: ExclusionCounts;
  readonly pending: number;
  readonly disputed: number;
  /** Where each model landed against the reference, over gold cases only. */
  readonly agreement: readonly ModelAgreement[];
  readonly disagreements: readonly Disagreement[];
  /** Non-blocking notes raised by the dataset check. */
  readonly findings: readonly Finding[];
}

/** A `sha256:` digest that changes whenever any decision or opinion changes. */
export function datasetDigest(inspection: DatasetInspection): string {
  return digestOf({
    manifest: inspection.manifest,
    cases: inspection.cases.map((entry) => entry.document),
    labels: [...inspection.labels.gold, ...inspection.labels.excluded].map(
      (assessment) => assessment.label,
    ),
    reviews: inspection.reviews.map((entry) => entry.document),
  });
}

/** The behaviours a label's legal pairs reach, as a stable list. */
function referenceBehaviours(label: ReviewLabel): readonly string[] {
  const pairs = legalPairs(label);
  if (pairs === null) return [];
  return [...new Set(matrixBehaviours(pairs).map((entry) => entry.behaviour))];
}

/** Whether a model's pair is one of the pairs the adjudicator allowed. */
function pairAllowed(label: ReviewLabel, opinion: ModelOpinion): boolean {
  if (opinion.risk === null || opinion.authorization === null) return false;
  const pairs: readonly ScorePair[] | null = legalPairs(label);
  if (pairs === null) return false;
  return pairs.some(
    ([risk, authorization]) =>
      risk === opinion.risk && authorization === opinion.authorization,
  );
}

/** The observed behaviour of one opinion, or null when it cannot be scored. */
function observedBehaviour(opinion: ModelOpinion): string | null {
  if (opinion.risk === null || opinion.authorization === null) return null;
  return (
    matrixBehaviours([[opinion.risk, opinion.authorization]])[0]?.behaviour ??
    null
  );
}

/** Accumulate agreement per model identity over the gold labels. */
function agreementOf(
  gold: readonly ReviewLabel[],
  reviews: readonly CaseReviews[],
): readonly ModelAgreement[] {
  const labelByCase = new Map(
    gold.map((label) => [label.caseId, label] as const),
  );
  const counts = new Map<
    string,
    { model: ModelOpinion['model']; compared: number; agreed: number }
  >();
  for (const file of reviews) {
    const label = labelByCase.get(file.caseId);
    if (label === undefined) continue;
    for (const opinion of file.reviews) {
      const key = `${opinion.model.provider}/${opinion.model.id}`;
      const entry = counts.get(key) ?? {
        model: opinion.model,
        compared: 0,
        agreed: 0,
      };
      // An unanswered field is not a disagreement, it is an absence: counting it
      // as wrong would report a model as mistaken for not being asked.
      if (opinion.risk !== null && opinion.authorization !== null) {
        entry.compared += 1;
        if (pairAllowed(label, opinion)) entry.agreed += 1;
      }
      counts.set(key, entry);
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => ({
      provider: entry.model.provider,
      id: entry.model.id,
      compared: entry.compared,
      agreed: entry.agreed,
    }));
}

/** List the opinions whose behaviour differs from the reference. */
function disagreementsOf(
  gold: readonly ReviewLabel[],
  reviews: readonly CaseReviews[],
): readonly Disagreement[] {
  const labelByCase = new Map(
    gold.map((label) => [label.caseId, label] as const),
  );
  const out: Disagreement[] = [];
  for (const file of reviews) {
    const label = labelByCase.get(file.caseId);
    if (label === undefined) continue;
    const reference = label.target.behaviourReference;
    if (reference === null) continue;
    const reachable = referenceBehaviours(label);
    for (const opinion of file.reviews) {
      const observed = observedBehaviour(opinion);
      if (observed === null || reachable.includes(observed)) continue;
      out.push({
        caseId: label.caseId,
        reviewId: opinion.reviewId,
        model: `${opinion.model.provider}/${opinion.model.id}`,
        risk: opinion.risk,
        authorization: opinion.authorization,
        observed,
        reference,
      });
    }
  }
  return out;
}

/** Build the summary for one inspected dataset. */
export function summarizeDataset(
  inspection: DatasetInspection,
): DatasetSummary {
  const excluded = inspection.labels.excluded;
  const exclusions: Record<ExclusionReason, number> = {
    'case-missing': 0,
    'input-changed': 0,
    'version-drift': 0,
    'not-approved': 0,
    'no-score': 0,
    indeterminate: 0,
  };
  for (const assessment of excluded) {
    // A label can fail for several reasons; each is counted so a reader sees the
    // whole cause rather than only the first one checked.
    for (const reason of assessment.reasons) exclusions[reason] += 1;
  }
  const all = [...inspection.labels.gold, ...excluded].map(
    (assessment) => assessment.label,
  );
  return {
    datasetId: inspection.manifest?.datasetId ?? null,
    versions: inspection.manifest?.versions ?? null,
    totals: {
      cases: inspection.cases.length,
      families: inspection.manifest?.families.length ?? 0,
      labels: all.length,
      reviews: inspection.reviews.reduce(
        (total, entry) => total + entry.document.reviews.length,
        0,
      ),
    },
    gold: inspection.labels.gold.length,
    excluded: excluded.length,
    exclusions,
    pending: all.filter((label) => label.target.status === 'pending').length,
    disputed: all.filter((label) => label.target.status === 'disputed').length,
    agreement: agreementOf(
      inspection.labels.gold.map((assessment) => assessment.label),
      inspection.reviews.map((entry) => entry.document),
    ),
    disagreements: disagreementsOf(
      inspection.labels.gold.map((assessment) => assessment.label),
      inspection.reviews.map((entry) => entry.document),
    ),
    findings: inspection.findings,
  };
}
