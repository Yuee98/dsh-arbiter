/**
 * N0 — how a protocol answer becomes a public 1–10 score.
 *
 * The decision protocol answers with a probability distribution over its ten
 * native levels; chat answers with one public integer. Both converge on the same
 * public scale here, and nowhere else:
 *
 *   public score = the band at which the cumulative mass first reaches the mark
 *
 * The mark is deliberately asymmetric. Risk takes the first band whose cumulative
 * mass is **strictly greater** than one half; authorization takes the first band
 * whose cumulative mass is **greater than or equal**. An exact half therefore
 * splits the two: risk leans to the more severe band, authorization to the band
 * that is already covered. That asymmetry is a product decision from the rubric,
 * not an implementation detail.
 *
 * Validation is strict on purpose. A distribution that does not sum to one, omits
 * a level, carries an out-of-range level, or holds a non-finite or negative
 * probability is rejected. Re-weighting such an answer would silently manufacture
 * a score the reviewer never gave, and averaging a `score` field instead would do
 * the same; neither happens here.
 */

import type {
  ChatScores,
  DecisionScores,
  ProtocolScores,
  PublicScore,
  ScoreAudit,
  ScoreDistribution,
  ScoreFailure,
  ScoreFailureReason,
  ScoreTrail,
} from './types.js';
import { isPublicScore } from './rubrics.js';

/** The highest native level the decision protocol can name. */
const NATIVE_MAX = 9;

/**
 * How far a submitted total may sit from one.
 *
 * The protocol sends finite decimals, so its own rounding is the only error this
 * tolerance absorbs. Ten entries rounded to four decimals can drift up to 5e-4 in
 * the extreme, but every captured real answer sums to exactly 1.0, so the bound is
 * kept at 1e-4: wide enough for ordinary rounding, far too narrow to admit a
 * 0.95 or 1.05 total that would change the score. A wider bound would be a
 * semantic decision that needs its own evidence, so it is not taken here.
 */
export const SUM_TOLERANCE = 1e-4;

/** The public score a chat integer names, or why it names none. */
export function chatScore(value: unknown):
  | { readonly ok: true; readonly score: PublicScore }
  | {
      readonly ok: false;
      readonly reason: ScoreFailureReason;
      readonly detail: string;
    } {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return {
      ok: false,
      reason: 'score-not-integer',
      detail: `expected an integer, received ${describe(value)}`,
    };
  }
  if (!isPublicScore(value)) {
    return {
      ok: false,
      reason: 'score-out-of-range',
      detail: `expected 1..10, received ${String(value)}`,
    };
  }
  return { ok: true, score: value };
}

/**
 * What went wrong with one decision field, or that nothing did.
 *
 * The whole distribution is checked before any score is derived, so a rejected
 * field never leaves a partially-read score behind.
 */
export function validateNativeDistribution(
  value: unknown,
): Either<ScoreDistribution> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'not-an-object',
      `expected an object, received ${describe(value)}`,
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return fail('not-an-object', 'expected at least one level, received none');
  }
  let total = 0;
  let nonZero = 0;
  for (const [key, raw] of entries) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < 0 || level > NATIVE_MAX) {
      return fail(
        'level-out-of-range',
        `level "${key}" is outside 0..${String(NATIVE_MAX)}`,
      );
    }
    if (typeof raw !== 'number') {
      return fail(
        'probability-not-finite',
        `level ${key} holds ${describe(raw)} rather than a probability`,
      );
    }
    if (!Number.isFinite(raw)) {
      return fail('probability-not-finite', `level ${key} is not finite`);
    }
    if (raw < 0) {
      return fail('probability-negative', `level ${key} is negative`);
    }
    total += raw;
    if (raw > 0) nonZero += 1;
  }
  if (nonZero === 0) {
    return fail('probability-sum-not-one', 'every level holds zero mass');
  }
  if (Math.abs(total - 1) > SUM_TOLERANCE) {
    return fail(
      'probability-sum-not-one',
      `total is ${total.toFixed(6)}, which is not 1 within ${String(SUM_TOLERANCE)}`,
    );
  }
  return { ok: true, value: { ...value } };
}

/** The cumulative mass through one native level, inclusive. */
export function cumulative(
  distribution: ScoreDistribution,
  level: number,
): number {
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (Number(key) <= level) sum += value;
  }
  return sum;
}

/**
 * The band a distribution selects, whichever numbering it is keyed by.
 *
 * `risk` crosses at *strictly more* than one half; `authorization` at *at least*
 * one half, so an exact half leans toward the more severe band for risk and toward
 * the already-covered band for authorization. `base` is 0 for the protocol's native
 * numbering and 1 for the public one — the cumulative rule is identical either way,
 * which is why both callers share this one implementation instead of holding two
 * spellings of it.
 */
export function bandFrom(
  distribution: ScoreDistribution,
  base: 0 | 1,
  rule: 'risk' | 'authorization',
): PublicScore {
  const highest = base === 0 ? NATIVE_MAX : 10;
  let running = 0;
  for (let level = base; level <= highest; level += 1) {
    running += distribution[String(level)] ?? 0;
    const reached = rule === 'risk' ? running > 0.5 : running >= 0.5;
    if (reached) return publicScoreAt(level, base);
  }
  // Unreachable for a validated distribution: a total of one always crosses one
  // half. Returning the top band keeps the function total rather than throwing on
  // a value that validation should have rejected first.
  return publicScoreAt(highest, base);
}

/** The band a validated native distribution selects. */
export function bandFromNative(
  distribution: ScoreDistribution,
  rule: 'risk' | 'authorization',
): PublicScore {
  return bandFrom(distribution, 0, rule);
}

/** The band a public-scale distribution selects (the engine's own numbering). */
export function bandFromPublic(
  distribution: ScoreDistribution,
  rule: 'risk' | 'authorization',
): PublicScore {
  return bandFrom(distribution, 1, rule);
}

/** The public score a selected level names, under either numbering. */
function publicScoreAt(level: number, base: 0 | 1): PublicScore {
  const score = base === 0 ? level + 1 : level;
  if (!isPublicScore(score)) {
    throw new RangeError(
      `level ${String(level)} under base ${String(base)} names no public score`,
    );
  }
  return score;
}

/** The same distribution re-keyed onto the public scale, mass preserved. */
export function distributionToPublic(
  distribution: ScoreDistribution,
): ScoreDistribution {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(distribution)) {
    out[String(Number(key) + 1)] = value;
  }
  return out;
}

/** The probability-weighted band, retained for display only. */
export function weightedBand(distribution: ScoreDistribution): number {
  let total = 0;
  for (const [key, value] of Object.entries(distribution)) {
    total += (Number(key) + 1) * value;
  }
  return total;
}

/** Both scores from one protocol answer, or every field that failed. */
export function readProtocolScores(scores: ProtocolScores):
  | {
      readonly ok: true;
      readonly risk: PublicScore;
      readonly authorization: PublicScore;
      readonly audit: ScoreAudit;
    }
  | { readonly ok: false; readonly failures: readonly ScoreFailure[] } {
  return scores.source === 'chat'
    ? readChatScores(scores)
    : readDecisionScores(scores);
}

function readChatScores(scores: ChatScores):
  | {
      readonly ok: true;
      readonly risk: PublicScore;
      readonly authorization: PublicScore;
      readonly audit: ScoreAudit;
    }
  | { readonly ok: false; readonly failures: readonly ScoreFailure[] } {
  const failures: ScoreFailure[] = [];
  const risk = chatScore(scores.risk);
  if (!risk.ok) {
    failures.push({ field: 'risk', reason: risk.reason, detail: risk.detail });
  }
  const authorization = chatScore(scores.authorization);
  if (!authorization.ok) {
    failures.push({
      field: 'authorization',
      reason: authorization.reason,
      detail: authorization.detail,
    });
  }
  if (!risk.ok || !authorization.ok) return { ok: false, failures };
  return {
    ok: true,
    risk: risk.score,
    authorization: authorization.score,
    audit: {
      risk: pointTrail(risk.score),
      authorization: pointTrail(authorization.score),
    },
  };
}

function readDecisionScores(scores: DecisionScores):
  | {
      readonly ok: true;
      readonly risk: PublicScore;
      readonly authorization: PublicScore;
      readonly audit: ScoreAudit;
    }
  | { readonly ok: false; readonly failures: readonly ScoreFailure[] } {
  const failures: ScoreFailure[] = [];
  const risk = validateNativeDistribution(scores.risk);
  if (!risk.ok) {
    failures.push({ field: 'risk', reason: risk.reason, detail: risk.detail });
  }
  const authorization = validateNativeDistribution(scores.authorization);
  if (!authorization.ok) {
    failures.push({
      field: 'authorization',
      reason: authorization.reason,
      detail: authorization.detail,
    });
  }
  if (!risk.ok || !authorization.ok) return { ok: false, failures };
  return {
    ok: true,
    risk: bandFromNative(risk.value, 'risk'),
    authorization: bandFromNative(authorization.value, 'authorization'),
    audit: {
      risk: distributionTrail(risk.value, 'risk'),
      authorization: distributionTrail(authorization.value, 'authorization'),
    },
  };
}

function pointTrail(score: PublicScore): ScoreTrail {
  return { native: null, published: null, point: score, score };
}

function distributionTrail(
  native: ScoreDistribution,
  rule: 'risk' | 'authorization',
): ScoreTrail {
  return {
    native,
    published: distributionToPublic(native),
    point: null,
    score: bandFromNative(native, rule),
  };
}

/** A single-value success or a labelled failure. */
type Either<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: ScoreFailureReason;
      readonly detail: string;
    };

function fail(reason: ScoreFailureReason, detail: string): Either<never> {
  return { ok: false, reason, detail };
}

/** A bounded, non-echoing description of an unexpected value. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.length > 32
      ? `a string of length ${String(value.length)}`
      : value;
  }
  return typeof value;
}
