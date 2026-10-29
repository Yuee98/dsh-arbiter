/**
 * The shared review contract: public 1–10 scores, protocol inputs and outcomes.
 *
 * Both reviewer protocols and the evals tooling speak this vocabulary. The
 * public scale has exactly ten ordered levels; the decision protocol carries
 * ten native levels that map onto it, and a chat answer is already public.
 * Nothing here reads the environment, the host, a clock or the network, so the
 * same values mean the same thing wherever they are computed.
 */

import type { ReviewVerdict } from '../types.js';

/** The public scale. One is the lowest level, ten the highest. */
export type PublicScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** A level as the decision protocol numbers its criteria. */
export type NativeLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Which protocol produced the scores. */
export type ScoreSource = 'chat' | 'decision';

/**
 * A probability distribution keyed by level.
 *
 * Native keys are the single characters `"0"`–`"9"`; public keys are `"1"`–`"10"`.
 * Absent levels carry no mass. A distribution is never re-weighted to make it
 * sum to one, so the keys and values here are what the protocol actually said.
 */
export type ScoreDistribution = Readonly<Record<string, number>>;

/** A chat answer: two public integers, used as given. */
export interface ChatScores {
  readonly source: 'chat';
  readonly risk: number;
  readonly authorization: number;
}

/** A decision answer: two native distributions, normalized here. */
export interface DecisionScores {
  readonly source: 'decision';
  readonly risk: ScoreDistribution;
  readonly authorization: ScoreDistribution;
}

/** What the reviewer protocol returned, before any interpretation. */
export type ProtocolScores = ChatScores | DecisionScores;

/** Why one score could not be read as a legal value. */
export type ScoreFailureReason =
  | 'not-an-object'
  | 'level-out-of-range'
  | 'probability-not-finite'
  | 'probability-negative'
  | 'probability-sum-not-one'
  | 'score-not-integer'
  | 'score-out-of-range';

/** One rejected score, kept per field so a caller can report all of them. */
export interface ScoreFailure {
  readonly field: 'risk' | 'authorization';
  readonly reason: ScoreFailureReason;
  /** What was observed, bounded and free of reviewer output. */
  readonly detail: string;
}

/** A hole in the material this review needed, reported by its source. */
export interface MaterialGap {
  /** The source that could not supply its material. */
  readonly source: string;
  /** Why the source is missing, as the collector observed it. */
  readonly reason: string;
}

/**
 * How a score was reached, retained for audit.
 *
 * `native` is the protocol's own distribution (null for chat), `published` is
 * the same mass re-keyed to the public scale, and `point` is the chat integer
 * (null for a distribution). The audit never decides a branch: it only lets a
 * reader reconstruct what the reviewer said.
 */
export interface ScoreTrail {
  readonly native: ScoreDistribution | null;
  readonly published: ScoreDistribution | null;
  readonly point: number | null;
  readonly score: PublicScore;
}

/** One trail per scored field. */
export interface ScoreAudit {
  readonly risk: ScoreTrail;
  readonly authorization: ScoreTrail;
}

/** A valid pair of scores, with the matrix verdict already applied. */
export interface ScoredReview {
  readonly status: 'scored';
  readonly source: ScoreSource;
  readonly risk: PublicScore;
  readonly authorization: PublicScore;
  /** The weakest authorization the shared matrix permits at this risk. */
  readonly requiredAuthorization: PublicScore;
  readonly verdict: ReviewVerdict;
  readonly audit: ScoreAudit;
}

/**
 * The material this review needed was absent or unreadable.
 *
 * `diagnostic` is what the reviewer did answer, if it answered anything. It is
 * recorded so a reader can see the partial result; it must never be turned into
 * a verdict, because the material that would justify one is missing.
 */
export interface InsufficientMaterialReview {
  readonly status: 'insufficient-material';
  readonly gaps: readonly MaterialGap[];
  readonly reason: string;
  readonly diagnostic: {
    readonly risk: PublicScore;
    readonly authorization: PublicScore;
  } | null;
}

/** The reviewer call, its output or its transport failed. */
export interface ReviewFailureOutcome {
  readonly status: 'review-failure';
  readonly failures: readonly ScoreFailure[];
  readonly reason: string;
}

/** Everything one review can produce before it is settled. */
export type ReviewOutcome =
  ScoredReview | InsufficientMaterialReview | ReviewFailureOutcome;

/** Whether the material a review needs is available. */
export type MaterialAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'insufficient'; readonly gaps: readonly MaterialGap[] };

/** What one review is asked with. */
export interface ReviewEvaluation {
  readonly scores: ProtocolScores;
  /** Absent means the collector found nothing missing. */
  readonly material?: MaterialAvailability;
}
