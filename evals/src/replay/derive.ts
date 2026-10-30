/**
 * Re-deriving one cell from the response the runner saved.
 *
 * This module is the whole of the replay's judgement, and it deliberately owns no
 * arithmetic of its own. Every semantic step is a call into the same code the
 * production review makes:
 *
 *   reading the answer      `readChatAnswer` / `readDecisionAnswer` — the adapters'
 *                           own readers, not a second parse of token text
 *   selecting a band        `bandFrom` — the shared N0 comparison, including its
 *                           exact-decimal cumulative sum
 *   deciding the verdict    `scoreReview` — the one shared matrix
 *   material availability   `materialAvailability` — M0's own reading of the gaps
 *
 * What this module adds is *which* of those the variant asks for, and the failure
 * precedence that keeps a technical fault a technical fault.
 *
 * ## Two rules that decide most of the outcomes
 *
 * **A failure is never re-scored.** Production decides a provider refusal, a
 * transport fault or an unreadable answer before it looks at any band, and the
 * recorded outcome says which of those happened. A body that carries complete
 * answers beside `success: false` is a failure in every variant: re-reading it
 * would let a threshold change turn a refusal into an approval, which is the one
 * thing this feature must not do. The attempt's own `failureKind` is checked as
 * well as the outcome, so the precedence is the replay's stated rule rather than
 * an accident of which field happened to be written first.
 *
 * **An answer that cannot be reconstructed is reported, not repaired.** Masking
 * happens in the production adapter, before the record exists, and masking a
 * decision body can leave text that is no longer valid JSON (see
 * `evals/README.md`). When the stored text does not read, the cell is
 * `not-replayable` with the reason — the stored outcome stands and the lineage
 * says why. The alternative, filling the gap from the adapter's parse or from a
 * best-effort recovery, would present a fabricated score as a re-read one.
 */

import {
  bandFrom,
  distributionToPublic,
  evaluateReview,
  materialAvailability,
  scoreReview,
  validateNativeDistribution,
} from '../../../src/review-contract/index.js';
import type {
  ProtocolScores,
  PublicScore,
  ReviewOutcome,
  ScoreAudit,
  ScoreDistribution,
  ScoreTrail,
} from '../../../src/review-contract/index.js';
import type { ReviewAttempt } from '../../../src/reviewer/attempt.js';
import {
  readChatAnswer,
  readDecisionAnswer,
} from '../../../src/reviewer/signals.js';
import type { ParsedAnswer } from '../../../src/reviewer/signals.js';

import type { CellRecord } from '../run/types.js';

import { sha256Text } from '../data/hash.js';

import type {
  ThresholdRule,
  OutcomeFacts,
  ReplayCellLineage,
  ReplayDisposition,
  ReplayVariant,
  SourceFile,
} from './types.js';
import { PRODUCTION_THRESHOLDS } from './types.js';

/**
 * Which comparison production applies for a field.
 *
 * The shared reader takes the *field name* and derives the comparison from it:
 * risk uses strictly-more-than-one-half, authorization at-least-one-half. A
 * replay that varies the threshold therefore has to name the comparison it wants, and
 * this table is that correspondence — read from `bandFrom`'s own two branches and
 * nowhere re-implemented. If production ever gave both fields one comparison, this
 * table would stop being meaningful and the replay's threshold axis would have to be
 * removed rather than silently mapped onto a rule that no longer exists.
 */
const RULE_FOR_THRESHOLD: Readonly<
  Record<ThresholdRule, 'risk' | 'authorization'>
> = {
  strict: 'risk',
  'at-least': 'authorization',
};

/** The band a validated native distribution selects under one threshold. */
export function bandUnder(
  distribution: ScoreDistribution,
  threshold: ThresholdRule,
): PublicScore {
  return bandFrom(distribution, 0, RULE_FOR_THRESHOLD[threshold]);
}

/** Whether this variant changes anything about how a band is selected. */
export function thresholdsAreProduction(
  thresholds: ReplayVariant['thresholds'],
): boolean {
  return (
    thresholds.risk === PRODUCTION_THRESHOLDS.risk &&
    thresholds.authorization === PRODUCTION_THRESHOLDS.authorization
  );
}

/** What a stored attempt offered the replay. */
type AnswerRead =
  /** The production reader accepted this answer and returned its scores. */
  | { readonly kind: 'read'; readonly scores: ProtocolScores }
  /**
   * The stored copy exists but no longer reads. `reason` names what happened in
   * the adapter's own terms; it never quotes the body.
   */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** The stored copy the variant asked for is not in this attempt at all. */
  | { readonly kind: 'absent'; readonly reason: string };

/**
 * Read the recorded parse of one attempt.
 *
 * A chat record stores the answer object the reader extracted, so the production
 * chat reader is given that object re-serialised: two integers have no ordering
 * to lose, and the reader still performs every check (exact member set, integer,
 * range) rather than trusting the stored parse.
 *
 * A decision record stores the `answers` object, and the production reader reads
 * that member from an envelope. Wrapping it back into the native envelope is what
 * lets the same reader run; the wrap does not supply any value the record did not
 * already carry.
 */
function parsedAnswerOf(
  attempt: ReviewAttempt,
  protocol: 'chat' | 'decision',
): AnswerRead {
  const parsed = attempt.parsed;
  if (parsed === null || parsed === undefined) {
    return {
      kind: 'absent',
      reason: 'the attempt recorded no parsed answer',
    };
  }
  return protocol === 'chat'
    ? readAnswerFrom(attempt, 'chat', JSON.stringify(parsed))
    : readAnswerFrom(attempt, 'decision', { answers: parsed });
}

/** Read the recorded response body of one attempt. */
function textAnswerOf(
  attempt: ReviewAttempt,
  protocol: 'chat' | 'decision',
): AnswerRead {
  const text = attempt.responseText;
  if (text === null) {
    return {
      kind: 'absent',
      reason: 'the attempt recorded no response body',
    };
  }
  if (protocol === 'chat') return readAnswerFrom(attempt, 'chat', text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      kind: 'unreadable',
      reason:
        'the recorded body is not valid JSON, so the production parser cannot be run on it; this is the masking boundary described in evals/README.md, not a malformed answer',
    };
  }
  return readAnswerFrom(attempt, 'decision', body);
}

/** Run whichever production reader this protocol uses and classify its verdict. */
function readAnswerFrom(
  attempt: ReviewAttempt,
  protocol: 'chat' | 'decision',
  input: unknown,
): AnswerRead {
  const parsed: ParsedAnswer =
    protocol === 'chat' && typeof input === 'string'
      ? readChatAnswer(input)
      : readDecisionAnswer(input);
  if (parsed.ok) return { kind: 'read', scores: parsed.scores };
  // The reader's own sentence names the violated rule and never the submitted
  // text, which is exactly what belongs in a lineage record.
  return {
    kind: 'unreadable',
    reason: `the production parser rejected the stored answer for ${attempt.attemptId}: ${parsed.error}`,
  };
}

/**
 * The attempt whose answer decided this cell, and what that attempt offered.
 *
 * Production stops at the first answer that reads: a chat repair exists only
 * because the earlier attempt did not read, and a decision call has one attempt.
 * Walking in order and taking the first readable answer therefore reproduces the
 * adapter's own selection instead of inventing a "best of" rule.
 */
function answerOf(
  record: CellRecord,
  variant: ReplayVariant,
): { readonly attempt: ReviewAttempt; readonly answer: AnswerRead } | null {
  const protocol = record.target.protocol;
  let firstFailure: AnswerRead | null = null;
  for (const attempt of record.attempts) {
    if (attempt.sent === false) continue;
    const answer =
      variant.answer === 'response-text'
        ? textAnswerOf(attempt, protocol)
        : parsedAnswerOf(attempt, protocol);
    if (answer.kind === 'read') return { attempt, answer };
    firstFailure = firstFailure ?? answer;
  }
  // At least one attempt exists, so `firstFailure` is set whenever the loop ran;
  // an empty attempt list leaves it null and the caller reports that separately.
  const attempt = record.attempts.find((entry) => entry.sent !== false);
  return attempt === undefined || firstFailure === null
    ? null
    : { attempt, answer: firstFailure };
}

/**
 * Whether the recorded evidence says this cell failed before any band was read.
 *
 * The two facts are checked separately because either one on its own is decisive:
 * the transport's failure class is what production's own adapter wrote, and the
 * stored outcome is what the contract concluded. A cell whose attempts declare a
 * provider refusal or a transport fault is a failure whatever its outcome field
 * says — that combination cannot arise from this runner today, but a hand-edited
 * or future-written record must not be able to become an approval here.
 */
function recordedFailureReason(record: CellRecord): string | null {
  const failed = record.attempts.find(
    (attempt) =>
      attempt.failureKind === 'provider-refusal' ||
      attempt.failureKind === 'transport',
  );
  if (failed !== undefined) {
    return `attempt ${failed.attemptId} recorded ${String(failed.failureKind)}; a provider or transport failure keeps its priority over whatever answers the body carried`;
  }
  if (record.outcome?.status === 'review-failure') {
    return `the stored outcome is a review failure: ${record.outcome.reason}`;
  }
  return null;
}

/**
 * The audit trails for a derived decision score.
 *
 * The distributions and their public re-keying come from the shared contract; only
 * the selected band is this replay's, and it was produced by `bandFrom` under the
 * variant's threshold. Nothing here recomputes a cumulative sum.
 */
function derivedAudit(parts: {
  readonly scores: ProtocolScores;
  readonly risk: PublicScore;
  readonly authorization: PublicScore;
}): ScoreAudit {
  if (parts.scores.source === 'chat') {
    // A chat answer is already on the public scale; no cumulative rule applies.
    return {
      risk: pointTrail(parts.scores.risk, parts.risk),
      authorization: pointTrail(
        parts.scores.authorization,
        parts.authorization,
      ),
    };
  }
  return {
    risk: distributionTrail(parts.scores.risk, parts.risk),
    authorization: distributionTrail(
      parts.scores.authorization,
      parts.authorization,
    ),
  };
}

/** The audit trail of one chat answer. */
function pointTrail(value: number, score: PublicScore): ScoreTrail {
  return { native: null, published: null, point: value, score };
}

/** The audit trail of one decision distribution. */
function distributionTrail(
  native: ScoreDistribution,
  score: PublicScore,
): ScoreTrail {
  return {
    native,
    published: distributionToPublic(native),
    point: null,
    score,
  };
}

/**
 * The outcome the variant reaches from one answer.
 *
 * Three paths, in the order production decides them:
 *
 *   1. the variant asks for the thresholds production uses, so the contract's own
 *      `evaluateReview` runs and the result is production's, byte for byte. This
 *      is what makes "the same version reproduces the original result" true by
 *      construction rather than by a comparison of two implementations.
 *   2. the variant asks for different thresholds and the answer is a decision
 *      distribution: the two bands are selected with `bandFrom`, the distributions
 *      are validated by the shared validator first, and `scoreReview` decides.
 *   3. any other shape — a chat point, an insufficient material, an invalid
 *      distribution — is production's own outcome, because a threshold selects a band
 *      and these outcomes have no band to select.
 */
function outcomeFor(parts: {
  readonly record: CellRecord;
  readonly scores: ProtocolScores;
  readonly variant: ReplayVariant;
}): { readonly outcome: ReviewOutcome; readonly note: string | null } {
  const material = materialAvailability(
    parts.record.material?.blockingGaps ?? [],
  );
  const production = evaluateReview({ scores: parts.scores, material });
  if (thresholdsAreProduction(parts.variant.thresholds)) {
    return { outcome: production, note: null };
  }
  if (material.status === 'insufficient') {
    // M0 decides before any band is read, so a variant that changes the
    // comparison cannot turn an insufficiency into a score.
    return {
      outcome: production,
      note: 'the recorded material has blocking gaps, so the outcome is an insufficiency in every variant; a threshold selects a band and this outcome has none',
    };
  }
  if (parts.scores.source === 'chat') {
    return {
      outcome: production,
      note: 'the threshold axis does not apply to a chat answer: the integers are already on the public scale, so the recorded bands stand',
    };
  }
  // A distribution N0 rejects produces a failure through the contract's own
  // reader, which is where that failure belongs. Selecting a band from it would
  // need the very validation N0 exists to perform.
  const risk = validateNativeDistribution(parts.scores.risk);
  const authorization = validateNativeDistribution(parts.scores.authorization);
  if (!risk.ok || !authorization.ok) {
    return {
      outcome: production,
      note: 'N0 rejected at least one distribution, so the contract’s own failure stands and no band was selected',
    };
  }
  const derivedRisk = bandUnder(risk.value, parts.variant.thresholds.risk);
  const derivedAuthorization = bandUnder(
    authorization.value,
    parts.variant.thresholds.authorization,
  );
  return {
    outcome: scoreReview(derivedRisk, derivedAuthorization, {
      source: parts.scores.source,
      audit: derivedAudit({
        scores: parts.scores,
        risk: derivedRisk,
        authorization: derivedAuthorization,
      }),
    }),
    note: null,
  };
}

/** The decision-relevant facts of one outcome, for the lineage comparison. */
export function factsOf(outcome: ReviewOutcome | null): OutcomeFacts | null {
  if (outcome === null) return null;
  if (outcome.status !== 'scored') {
    // Neither of the other two outcomes states a score, so neither can be said to
    // have a band. Reporting the partial trail here would let a reader compare a
    // diagnostic against a decision.
    return {
      status: outcome.status,
      risk: null,
      authorization: null,
      verdict: null,
    };
  }
  return {
    status: outcome.status,
    risk: outcome.risk,
    authorization: outcome.authorization,
    verdict: outcome.verdict,
  };
}

/** Whether two outcome facts differ in anything a reader would act on. */
export function factsChanged(
  stored: OutcomeFacts | null,
  derived: OutcomeFacts | null,
): boolean {
  if (stored === null || derived === null) return false;
  return (
    stored.status !== derived.status ||
    stored.risk !== derived.risk ||
    stored.authorization !== derived.authorization ||
    stored.verdict !== derived.verdict
  );
}

/** One cell's replay: the lineage row and the record the derived run holds. */
export interface CellReplay {
  readonly lineage: ReplayCellLineage;
  /**
   * The record the derived directory stores — the stored one, a re-derived copy, or
   * null for a cell the source run never wrote.
   */
  readonly record: CellRecord | null;
  /** Whether the outcome was re-derived, so the caller can count it. */
  readonly reDerived: boolean;
}

/** A fixed shape for the identification fields of a cell. */
function identityOf(
  record: CellRecord,
): Pick<
  ReplayCellLineage,
  'cellId' | 'caseId' | 'targetId' | 'protocol' | 'repeat'
> {
  return {
    cellId: record.cellId,
    caseId: record.case.caseId,
    targetId: record.target.targetId,
    protocol: record.target.protocol,
    repeat: record.execution.repeat,
  };
}

/** A lineage row that changes nothing, with the reason it did not. */
function keptRow(parts: {
  readonly record: CellRecord;
  readonly disposition: ReplayDisposition;
  readonly reason: string;
  readonly responseDigest: string | null;
  readonly attemptId: string | null;
  readonly sourceFile: SourceFile | null;
}): CellReplay {
  return {
    lineage: {
      ...identityOf(parts.record),
      disposition: parts.disposition,
      reason: parts.reason,
      attemptId: parts.attemptId,
      responseDigest: parts.responseDigest,
      record: parts.sourceFile,
      stored: factsOf(parts.record.outcome),
      derived: null,
      changed: false,
    },
    record: parts.record,
    reDerived: false,
  };
}

/**
 * Re-derive one cell under one variant.
 *
 * `sourceFile` is the record the cell was read from and the digest that file had
 * when it was read, so the lineage can be checked against the run directory later
 * without trusting this module's copy of anything.
 */
export function replayCell(parts: {
  readonly record: CellRecord;
  readonly variant: ReplayVariant;
  /** The record file this cell was read from, with the digest it was read at. */
  readonly sourceFile: SourceFile;
}): CellReplay {
  const { record, variant } = parts;
  if (record.material === null) {
    return keptRow({
      record,
      disposition: 'not-replayable',
      reason:
        'the record carries no material block, so the completeness report the contract scores against cannot be reconstructed',
      attemptId: null,
      responseDigest: null,
      sourceFile: parts.sourceFile,
    });
  }
  if (record.outcome === null) {
    return keptRow({
      record,
      disposition: 'kept',
      reason:
        record.stopReason ??
        'the cell produced no outcome, so there is nothing to re-decide',
      attemptId: null,
      responseDigest: null,
      sourceFile: parts.sourceFile,
    });
  }
  const failure = recordedFailureReason(record);
  if (failure !== null) {
    return keptRow({
      record,
      disposition: 'kept',
      reason: failure,
      attemptId: null,
      responseDigest: null,
      sourceFile: parts.sourceFile,
    });
  }
  const found = answerOf(record, variant);
  if (found === null) {
    return keptRow({
      record,
      disposition: 'not-replayable',
      reason: 'the record holds no sent attempt to re-read',
      attemptId: null,
      responseDigest: null,
      sourceFile: parts.sourceFile,
    });
  }
  const digest =
    found.attempt.responseText === null
      ? null
      : sha256Text(found.attempt.responseText);
  if (found.answer.kind !== 'read') {
    return keptRow({
      record,
      disposition: 'not-replayable',
      reason: found.answer.reason,
      attemptId: found.attempt.attemptId,
      responseDigest: digest,
      sourceFile: parts.sourceFile,
    });
  }
  const derived = outcomeFor({
    record,
    scores: found.answer.scores,
    variant,
  });
  const stored = factsOf(record.outcome);
  const derivedFacts = factsOf(derived.outcome);
  const changed = factsChanged(stored, derivedFacts);
  const notes = [
    ...record.notes,
    `outcome re-derived offline by ${variant.variantId} from the stored answer of ${found.attempt.attemptId}; no request was made and the stored usage is unchanged`,
  ];
  return {
    lineage: {
      ...identityOf(record),
      disposition: 're-derived',
      // Every row says why it landed where it did. A re-derived cell that did not move
      // is not a silent row: it is the evidence that this axis did not matter for it.
      reason:
        derived.note ??
        (changed
          ? 'the derived outcome differs from the stored one'
          : 'the derived outcome is identical to the stored one'),
      attemptId: found.attempt.attemptId,
      responseDigest: digest,
      // The source record this row was read from, at the digest it was read at: a
      // re-derived row is still evidence about a specific file.
      record: parts.sourceFile,
      stored,
      derived: derivedFacts,
      changed,
    },
    record: {
      ...record,
      outcome: derived.outcome,
      notes,
    },
    reDerived: true,
  };
}
