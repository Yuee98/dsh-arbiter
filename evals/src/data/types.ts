/**
 * The evals data contract, in TypeScript.
 *
 * Three documents describe one dataset, and they are separately committed on
 * purpose:
 *
 *   case     what the reviewer is given, plus where it came from
 *   label    the user's adjudication of that case, bound to the case's input hash
 *   reviews  what each independent model answered, one file per case
 *
 * Splitting them is what keeps an answer away from anything a runner reads: a
 * runner only ever needs `cases/`, and a label file is the only place a score is
 * recorded. The JSON Schemas in `evals/schemas/` publish the same shapes for
 * editors and other tools; every document is checked against them when it loads.
 */

import type { PublicScore } from '../../../src/review-contract/types.js';

/** Which split a family belongs to. Families, not cases, are assigned. */
export type Split = 'dev' | 'calibration' | 'holdout';

/** Whether a case came from a real workflow, was rebuilt, or was written here. */
export type ProvenanceOf = 'real' | 'reconstructed' | 'synthetic';

/** One quotable point behind a decision. */
export interface Evidence {
  readonly kind: 'material-quote' | 'link' | 'note';
  readonly ref: string;
  readonly note?: string;
}

/** Where a case came from. Never derived from the review itself. */
export interface Provenance {
  readonly source: ProvenanceOf;
  readonly origin: string;
  readonly collectedAt: string;
  readonly notes?: string;
}

/** One earlier turn in the same session, oldest first. */
export interface ContextTurn {
  readonly tool: string;
  readonly arguments: string;
}

/** Everything a reviewer is given for one case. Nothing about the answer. */
export interface ReviewInput {
  readonly tool: string;
  readonly cwd?: string;
  readonly action: {
    readonly name: string;
    /** Free-form tool arguments, kept exactly as the call carried them. */
    readonly arguments?: unknown;
    readonly programText?: string;
  };
  readonly session: {
    readonly kind: 'main' | 'subagent';
    readonly parentAuthorizationPresent?: boolean | null;
  };
  readonly policy: {
    readonly projectRules: string | null;
    readonly customRules: string;
  };
  readonly hint?: string;
  readonly context?: readonly ContextTurn[];
  readonly evidence?: readonly Evidence[];
}

/** One reviewable case. */
export interface ReviewCase {
  readonly caseId: string;
  readonly familyId: string;
  readonly split: Split;
  readonly provenance: Provenance;
  readonly input: ReviewInput;
  readonly notes?: string;
}

/** The committed rubric snapshot document. */
export interface RubricSnapshot {
  readonly rubricVersion: string;
  readonly contractVersion: string;
  readonly source: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly risk: readonly PublishableBand[];
  readonly authorization: readonly PublishableBand[];
}

/** The three versions a label is only valid under. */
export interface LabelVersions {
  readonly contract: string;
  readonly rubric: string;
  readonly policy: string;
}

/**
 * The two score fields an adjudication covers.
 *
 * `null` means "undecidable under this material" and is a recorded state, not a
 * missing value: a case whose material cannot support a score has no legal score
 * set at all. It is never encoded as an empty list or a zero.
 */
export interface AllowedScores {
  readonly risk: readonly PublicScore[] | null;
  readonly authorization: readonly PublicScore[] | null;
}

/** What the reviewed call settles as, stated independently of the scores. */
export type BehaviourReference =
  'allow' | 'deny' | 'escalate' | 'insufficient-material' | 'review-failure';

/** How far the adjudication has got. Only `approved` can count as gold. */
export type LabelStatus = 'pending' | 'approved' | 'disputed';

/** One legal (risk, authorization) pair. */
export type ScorePair = readonly [PublicScore, PublicScore];

/** The user's adjudication for one case. */
export interface LabelTarget {
  readonly status: LabelStatus;
  readonly allowed: AllowedScores;
  /**
   * The legal pairs, stated explicitly whenever the two sets would otherwise
   * multiply out to more than one. A set is never read as its product.
   */
  readonly allowedPairs?: readonly ScorePair[];
  readonly behaviourReference: BehaviourReference | null;
  readonly evidence?: readonly Evidence[];
  readonly rationale: string;
  readonly decidedBy: string;
  readonly decidedAt: string | null;
}

/** One committed label. */
export interface ReviewLabel {
  readonly caseId: string;
  /** The input this adjudication was made against. */
  readonly inputHash: string;
  readonly versions: LabelVersions;
  readonly target: LabelTarget;
  readonly notes?: string;
}

/** The model behind one opinion. An unknown version stays unknown. */
export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
  readonly version: string | null;
  readonly versionSource: 'provider-reported' | 'user-stated' | 'unknown';
}

/** One model's independent answer for one case. */
export interface ModelOpinion {
  readonly reviewId: string;
  readonly model: ModelIdentity;
  readonly protocol: 'chat' | 'decision';
  /** `null` when that field was not answered; never a zero. */
  readonly risk: PublicScore | null;
  readonly authorization: PublicScore | null;
  readonly notes?: string;
  readonly recordedAt?: string;
}

/** The opinions collected for one case. */
export interface CaseReviews {
  readonly caseId: string;
  readonly inputHash: string;
  readonly reviews: readonly ModelOpinion[];
}

/** One family and the split it was assigned. */
export interface ManifestFamily {
  readonly familyId: string;
  readonly split: Split;
  readonly notes?: string;
}

/** One case the manifest expects to find. */
export interface ManifestCase {
  readonly caseId: string;
  readonly familyId: string;
}

/** A dataset's table of contents and current versions. */
export interface DatasetManifest {
  readonly datasetId: string;
  readonly description?: string;
  readonly versions: LabelVersions;
  readonly families: readonly ManifestFamily[];
  readonly cases: readonly ManifestCase[];
}

/** One band as the annotation document prints it for a human to grade against. */
export interface PublishableBand {
  readonly score: PublicScore;
  readonly criterion: string;
}

/** The blank adjudication an annotation document hands out. */
export type BlankTarget = Omit<LabelTarget, 'allowed' | 'allowedPairs'> & {
  readonly status: 'pending';
  readonly allowed: {
    readonly risk: readonly [];
    readonly authorization: readonly [];
  };
  readonly allowedPairs?: readonly [];
  readonly behaviourReference: null;
  readonly decidedAt: null;
};

/** One case as an annotation document presents it. */
export interface AnnotationEntry {
  readonly caseId: string;
  readonly familyId: string;
  readonly split: Split;
  readonly input: ReviewInput;
  readonly target: LabelTarget | BlankTarget;
}

/** The annotation document: exported blank, returned filled in. */
export interface AnnotationDocument {
  readonly packVersion: string;
  readonly datasetId: string;
  readonly exportedAt: string;
  /**
   * The versions in force when the pack was exported.
   *
   * A decision is made under the contract, rubric and policy that were current at
   * the time. Carrying them in the document is what lets an import refuse a fill
   * made under other semantics instead of stamping it with today's versions.
   */
  readonly versions: LabelVersions;
  readonly annotatedBy?: string;
  readonly rubric: {
    readonly rubricVersion: string;
    readonly source: { readonly path: string; readonly sha256: string };
    readonly risk: readonly PublishableBand[];
    readonly authorization: readonly PublishableBand[];
  };
  readonly entries: readonly AnnotationEntry[];
}
