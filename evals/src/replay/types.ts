/**
 * The offline replay's vocabulary.
 *
 * A replay answers one question: *if the same saved answer had been read under a
 * different rule, what would this run have concluded?* It is therefore an
 * operation on evidence that already exists — never a second dispatch — and its
 * whole output is a derived view of one source run, labelled with the rule it
 * used.
 *
 * Three axes can be varied, and only three, because those are the three things
 * production itself parameterises:
 *
 *   answer       which stored copy of the response is re-read by the production
 *                parser. `response-text` is the recorded body as the adapter
 *                masked it; `recorded-parse` is the adapter's own parse of the
 *                same body. The second exists because masking a decision body can
 *                leave text that is no longer valid JSON (see `evals/README.md`),
 *                and a replay that silently scored such a run from a repaired
 *                body would be inventing the answer it claims to re-read.
 *   thresholds        N0's judgement boundary: the cumulative mass at which a band is
 *                selected. Production uses `strict` for risk (strictly more than
 *                one half) and `at-least` for authorization (one half or more);
 *                both values are arguments production's `bandFrom` already takes.
 *   settlement   the ask policy and whether a human can be reached. This changes
 *                nothing about a score: production's `settle` decides where an
 *                escalation goes, and the report layer already computes it.
 *
 * What is deliberately *not* an axis: the shared matrix. It has one table
 * (`requiredAuthorizationFor`) and production has no second one, so replaying "a
 * different threshold" there would mean writing a second engine beside the one
 * being measured — and a new approval rule is a product decision that belongs to
 * the second review window, not to a tool. A replay that needs one must be
 * expressed as a matrix change reviewed on its own.
 *
 * Nothing in this module names a provider, a socket or an executor: a replay
 * reads files, calls the shared contract and writes a derived directory.
 */

import type { AskPolicy } from '../../../src/review-contract/matrix.js';

/** The derived index's implementation version, so a reader can tell it apart. */
export const REPLAY_IMPLEMENTATION_VERSION = 'eval-replayer-v1';

/** The variants document's own version. */
export const REPLAY_VARIANTS_VERSION = 'eval-replay-variants-v1';

/** The lineage document's own version. */
export const REPLAY_LINEAGE_VERSION = 'eval-replay-lineage-v1';

/**
 * Which stored copy of one answer is re-read.
 *
 * Both go through the production parser and the shared contract; they differ only
 * in which recorded artefact supplies the text.
 */
export type AnswerCandidate = 'response-text' | 'recorded-parse';

/**
 * N0's judgement boundary.
 *
 * `strict` selects the band whose cumulative mass is *strictly greater* than one
 * half, `at-least` the first band whose cumulative mass *reaches* it. The two are
 * production's own two comparison modes, which `bandFrom` takes as its third
 * argument; the names here describe the comparison instead of repeating the field
 * the argument happens to be named after.
 */
export type ThresholdRule = 'strict' | 'at-least';

/** One boundary per score, because production's are deliberately asymmetric. */
export interface ThresholdRules {
  readonly risk: ThresholdRule;
  readonly authorization: ThresholdRule;
}

/**
 * The boundaries the running production code applies.
 *
 * `readDecisionScores` selects risk with `bandFromNative(..., 'risk')` (strictly
 * greater) and authorization with `bandFromNative(..., 'authorization')` (greater
 * than or equal). A replay that names these changes nothing, which is what makes
 * "same version reproduces the original result" a checkable claim.
 */
export const PRODUCTION_THRESHOLDS: ThresholdRules = {
  risk: 'strict',
  authorization: 'at-least',
};

/** Which ask policy and channel the derived report settles under. */
export interface SettlementChoice {
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
}

/** One fully resolved replay configuration. */
export interface ReplayVariant {
  readonly answer: AnswerCandidate;
  readonly thresholds: ThresholdRules;
  readonly settlement: SettlementChoice;
  /**
   * The readable identity of the three axes.
   *
   * It names every axis, so two variants that differ anywhere get different
   * directories: `text-strict-at-least-ask-available` is "read the recorded body,
   * strict for risk, at-least for authorization, ask mode, channel available". It is
   * also the directory name, which is why it is a slug rather than a sentence.
   */
  readonly variantId: string;
  /**
   * The digest of the three axes, excluding the description.
   *
   * Editing a description must not fork a derivation, so the identity is the axes
   * rather than the prose: two derivations with the same digest are the same rule
   * under two names, and a document that holds both is refused.
   */
  readonly digest: string;
  /** What a person called this variant, carried into the lineage unchanged. */
  readonly description: string;
}

/** One file the source run's readable surface holds, with its digest. */
export interface SourceFile {
  /** Path relative to the run directory, so the record travels between machines. */
  readonly path: string;
  /** Digest of the document's UTF-8 bytes, exactly as they stand on disk. */
  readonly digest: string;
}

/** Why a cell's outcome was or was not re-derived. */
export type ReplayDisposition =
  /**
   * The production reader accepted the answer and the shared contract decided
   * again. `changed` says whether the result actually moved.
   */
  | 're-derived'
  /**
   * Deliberately kept as recorded, for a reason that is not a defect: the
   * variant cannot apply to this answer, or the recorded answer is a failure and
   * a failure keeps its priority under every boundary.
   */
  | 'kept'
  /**
   * The material needed to re-derive is absent or damaged, so nothing was
   * derived. The stored outcome stands and the cell is listed rather than
   * dropped.
   */
  | 'not-replayable'
  /** The source run has no record for this cell, so there is nothing to read. */
  | 'no-record';

/** What one outcome said, in the few members a comparison needs. */
export interface OutcomeFacts {
  readonly status: string;
  readonly risk: number | null;
  readonly authorization: number | null;
  readonly verdict: string | null;
}

/** One cell's provenance: what was read, what was derived, and what moved. */
export interface ReplayCellLineage {
  readonly cellId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: string;
  readonly repeat: number;
  readonly disposition: ReplayDisposition;
  /** Why, in the artifact's own words; null when the cell simply re-derived. */
  readonly reason: string | null;
  /** The attempt whose answer supplied the score, when one was read. */
  readonly attemptId: string | null;
  /** Digest of that attempt's stored response body, exactly as recorded. */
  readonly responseDigest: string | null;
  /** The source record file this cell was read from, and its digest. */
  readonly record: SourceFile | null;
  readonly stored: OutcomeFacts | null;
  readonly derived: OutcomeFacts | null;
  readonly changed: boolean;
}

/**
 * The comparison of a run's recorded inputs against the dataset as it is now.
 *
 * Three states, and the third is the one that keeps the record honest: a comparison
 * that could not run, or that could not cover every recorded case, must not be stored as
 * "nothing changed".
 */
export type InputStanding =
  | {
      readonly status: 'compared';
      /** Cases whose current input differs from the one the run recorded. */
      readonly drifted: readonly {
        readonly caseId: string;
        readonly recorded: string;
        readonly current: string;
      }[];
      /** Recorded cases whose current input could not be established. */
      readonly unverified: readonly {
        readonly caseId: string;
        readonly reason: string;
      }[];
      /** True when some recorded evidence cannot speak about the current material. */
      readonly reRequestRequired: boolean;
    }
  | {
      readonly status: 'undetermined';
      readonly reason: string;
      readonly reRequestRequired: boolean;
    };

/** One run directory, as the replay read it. */
export interface ReplaySource {
  /** The directory as the caller named it: relative to the root when inside it. */
  readonly directory: string;
  readonly runId: string;
  readonly planHash: string;
  readonly dataset: { readonly datasetId: string; readonly digest: string };
  /** The versions the source run recorded, untouched. */
  readonly versions: {
    readonly contract: string;
    readonly prompt: string;
    readonly usageMapping: string;
    readonly plan: string;
    readonly artifact: string;
    readonly implementation: string;
    readonly node: string | null;
  };
  /** Every document the replay read, with the digest it was read at. */
  readonly files: readonly SourceFile[];
}

/** What the replay produced, in totals a reader can check against the line list. */
export interface ReplayTotals {
  readonly cells: number;
  readonly reDerived: number;
  readonly kept: number;
  readonly notReplayable: number;
  readonly noRecord: number;
  /** Cells whose score pair, required authorization or verdict moved. */
  readonly changed: number;
}

/** The lineage document: what was replayed, from what, under which rule. */
export interface ReplayLineage {
  readonly documentVersion: typeof REPLAY_LINEAGE_VERSION;
  readonly replay: {
    readonly implementation: string;
    readonly variantId: string;
    readonly digest: string;
    readonly answer: AnswerCandidate;
    readonly thresholds: ThresholdRules;
    readonly settlement: SettlementChoice;
    readonly description: string;
    /**
     * The matrix the derived scores were decided by.
     *
     * Recorded as a fact rather than a knob: a replay never varies it, and saying
     * so is what stops a reader from assuming a candidate table was applied.
     */
    readonly matrix: 'shared';
    /** The contract version the re-derivation actually ran under. */
    readonly contract: string;
    /** The variants document's version, when the caller supplied one. */
    readonly variantsDocument: string | null;
  };
  readonly source: ReplaySource;
  readonly derived: {
    readonly directory: string;
    readonly runId: string;
    readonly report: readonly string[];
  };
  readonly totals: ReplayTotals;
  readonly cells: readonly ReplayCellLineage[];
  /**
   * How the saved evidence stands against the dataset as it is now.
   *
   * Persisted rather than only printed, because the derived lineage is what a later
   * reader consults. A warning that lived only on a terminal is gone the moment the
   * terminal closes, and the derivation then looks complete.
   */
  readonly inputs: InputStanding;
  readonly notes: readonly string[];
}
