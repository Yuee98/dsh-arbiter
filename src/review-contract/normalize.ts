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
 *
 * The value is a *decimal* 10^-4 and it is compared as one: see
 * {@link withinSumTolerance}. Reading it as a double would move the boundary by one
 * binary ulp, which is exactly the mistake that made a total of 0.9999 fail.
 */
export const SUM_TOLERANCE = 1e-4;

/**
 * The tolerance as a decimal literal, in the same vocabulary the sum uses.
 *
 * Deriving it from {@link SUM_TOLERANCE} rather than writing `'0.0001'` keeps one
 * source of truth: changing the constant changes the comparison, and the test that
 * pins both to each other fails if they ever drift apart.
 */
function toleranceDecimal(): string {
  const exact = exactDecimal(SUM_TOLERANCE);
  // `SUM_TOLERANCE` is a compile-time literal, so this is unreachable; returning the
  // plain literal would hide a future non-finite value behind a silent default.
  if (exact === null) {
    throw new RangeError('SUM_TOLERANCE has no exact decimal form');
  }
  return exact;
}

/**
 * Whether an exact decimal total is within {@link SUM_TOLERANCE} of one.
 *
 * The comparison is integer arithmetic on the submitted digits, not
 * `Math.abs(total - 1)`. The float form is wrong in both directions at the
 * boundary and it was observed failing outward on real answers: ten four-decimal
 * probabilities summing to a decimal 0.9999 accumulate to 0.9998999999999999, whose
 * float distance from one is 0.00010000000000010001 — one ulp past 1e-4, so a
 * total that is *exactly* at the tolerance was rejected. "Exactly at the bound" is
 * inside it here, which is the same inclusive reading N0's authorization rule uses.
 *
 * The magnitude is compared, so an over-total is held to the same bound: 1.0001 is
 * inside and 1.0002 is not.
 */
export function withinSumTolerance(sum: string): boolean {
  const scale = Math.max(decimalPlaces(sum), decimalPlaces(toleranceDecimal()));
  const scaledSum = scaleDecimal(sum, scale);
  const one = 10n ** BigInt(scale);
  const difference = scaledSum >= one ? scaledSum - one : one - scaledSum;
  return difference <= scaleDecimal(toleranceDecimal(), scale);
}

/** The digits after the point in an exact decimal string. */
function decimalPlaces(text: string): number {
  const point = text.indexOf('.');
  return point === -1 ? 0 : text.length - point - 1;
}

/** One exact decimal scaled by `10^scale` as an integer. */
function scaleDecimal(text: string, scale: number): bigint {
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = digits.split('.');
  const scaled = BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  return negative ? -scaled : scaled;
}

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
 * The exact decimal this double represents, or null when it has none.
 *
 * A probability arrives as a JavaScript number, and adding several of them can
 * land either side of one half purely because of binary rounding: ten values that
 * are exactly one in decimal can accumulate to 0.5000000000000001 or
 * 0.49999999999999994. N0's whole point is the difference between "at least half"
 * and "more than half", so the comparison is done on exact decimals instead.
 *
 * The shortest round-trip representation of a double is the decimal the protocol
 * most likely submitted, and every finite double has one, so this is total for
 * accepted input. A value that somehow has no such form is reported so the caller
 * can refuse it rather than guess.
 */
export function exactDecimal(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  const plain = /^-?\d+(?:\.\d+)?$/u.exec(text);
  if (plain !== null) return text;
  // A short value can render in exponent form ("1e-7"), which is still an exact
  // decimal. Expand it without rounding, so the digits are preserved rather than
  // dropped from the cumulative sum.
  const exponent = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/u.exec(text);
  if (exponent === null) return null;
  const [, sign = '', whole = '0', fraction = '', shift = '0'] = exponent;
  const digits = `${whole}${fraction}`;
  const point = whole.length + Number(shift);
  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Add exact decimal strings.
 *
 * Scaled-integer addition keeps every significant digit: unlike quantizing a
 * probability to a fixed number of places, it cannot move a value across the half
 * boundary, because it does not discard anything the answer carried.
 */
export function addDecimals(values: readonly string[]): string {
  let scale = 0;
  const parts = values.map((text) => {
    const [whole = '0', fraction = ''] = text.split('.');
    scale = Math.max(scale, fraction.length);
    return { whole, fraction };
  });
  let total = 0n;
  for (const { whole, fraction } of parts) {
    // Integer arithmetic on the scaled digits, so no precision is lost.
    const scaled = `${whole}${fraction.padEnd(scale, '0')}`;
    total += BigInt(scaled === '' ? '0' : scaled);
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total)
    .toString()
    .padStart(scale + 1, '0');
  // `scale` digits belong after the point; everything before them is the whole part.
  const wholePart = digits.slice(0, digits.length - scale);
  const fractionPart =
    scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${wholePart}${fractionPart}`;
}

/**
 * Compare an exact decimal sum with one half.
 *
 * Returns a positive number when the sum exceeds one half, zero when it is exactly
 * one half, and a negative number when it is below. The comparison doubles the sum
 * and compares against one, entirely in integer arithmetic, so it stays exact for
 * any number of decimal places.
 */
export function compareToHalf(sum: string): number {
  const doubled = addDecimals([sum, sum]);
  const [whole = '0', fraction = ''] = doubled.split('.');
  const scaled = BigInt(`${whole}${fraction.padEnd(fraction.length, '0')}`);
  const one = BigInt(`1${'0'.repeat(fraction.length)}`);
  return scaled > one ? 1 : scaled < one ? -1 : 0;
}

/**
 * What went wrong with one decision field, or that nothing did.
 *
 * Every distribution must carry exactly the ten canonical levels "0".."9". A
 * sparse object is not a shorter distribution: its missing mass has not been
 * reported as anything, so accepting it would invent a total. Non-canonical
 * spellings such as "00" are rejected for a sharper reason — two keys can name
 * the same level, and re-keying them onto the public scale would overwrite one
 * probability with the other and silently lose mass.
 *
 * The whole distribution is checked before any score is derived, so a rejected
 * field never leaves a partially-read score behind. Messages name the field and a
 * rule class only; they never echo submitted text, which may be a credential the
 * provider copied out of its own prompt.
 */
export function validateNativeDistribution(
  value: unknown,
): Either<ScoreDistribution> {
  return validateDistribution(value, 0, NATIVE_MAX, nativeKeyOf);
}

/**
 * The public-scale counterpart of the native validator.
 *
 * `ReviewSignals` publishes distributions on 1..10, so the same completeness and
 * canonical-key rules apply there. It is a separate function rather than a key
 * remap so an adapter cannot quietly hand native keys to the public path.
 */
export function validatePublicDistribution(
  value: unknown,
): Either<ScoreDistribution> {
  return validateDistribution(value, 1, 10, publicKeyOf);
}

/** The canonical key for one level in the given numbering. */
function nativeKeyOf(level: number): string | null {
  return level >= 0 && level <= NATIVE_MAX ? String(level) : null;
}

function publicKeyOf(level: number): string | null {
  return level >= 1 && level <= 10 ? String(level) : null;
}

function validateDistribution(
  value: unknown,
  base: 0 | 1,
  highest: number,
  canonicalKey: (level: number) => string | null,
): Either<ScoreDistribution> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('not-an-object', 'expected an object of probabilities');
  }
  const entries = Object.entries(value);
  const keyProblem = checkKeys(entries, base, highest, canonicalKey);
  if (keyProblem !== null) return keyProblem;
  return checkProbabilities(entries);
}

/**
 * Whether the submitted key set is exactly the canonical one.
 *
 * Two separate failures live here, and they are different facts: a key that cannot
 * name a level at all, and a key set that names fewer levels than the scale has.
 */
function checkKeys(
  entries: readonly (readonly [string, unknown])[],
  base: 0 | 1,
  highest: number,
  canonicalKey: (level: number) => string | null,
): Either<ScoreDistribution> | null {
  if (entries.length === 0) {
    return fail('not-an-object', 'expected ten levels, received none');
  }
  for (const [key] of entries) {
    const level = Number(key);
    if (!Number.isInteger(level) || canonicalKey(level) !== key) {
      return fail('level-out-of-range', 'a key is not a canonical level');
    }
  }
  const expected = highest - base + 1;
  return entries.length === expected
    ? null
    : fail(
        'level-set-incomplete',
        `expected ${String(expected)} canonical levels, received ${String(entries.length)}`,
      );
}

/** Every value is a finite, non-negative probability and the total is one. */
function checkProbabilities(
  entries: readonly (readonly [string, unknown])[],
): Either<ScoreDistribution> {
  const record: Record<string, number> = {};
  const exact: string[] = [];
  let nonZero = 0;
  for (const [key, raw] of entries) {
    const checked = readProbability(raw);
    if (typeof checked === 'string') return failProbability(checked, key);
    record[key] = checked;
    if (checked === 0) continue;
    const decimal = exactDecimal(checked);
    // Validation already refused non-finite values, so this is unreachable; refusing
    // loudly beats dropping a level's mass from the sum, which could move the total
    // into tolerance and accept a distribution nobody submitted.
    if (decimal === null) {
      return fail('probability-not-finite', `level ${key} has no exact form`);
    }
    exact.push(decimal);
    nonZero += 1;
  }
  if (nonZero === 0) {
    return fail('probability-sum-not-one', 'every level holds zero mass');
  }
  // The total is compared as the exact decimal the answer carries, in integer
  // arithmetic. Accumulating the doubles first and then taking `Math.abs(total - 1)`
  // is what rejected a total that sat exactly on the tolerance: 0.9999 accumulates to
  // 0.9998999999999999 and one ulp of float error decides a boundary the protocol
  // means in decimal.
  const total = addDecimals(exact);
  if (!withinSumTolerance(total)) {
    return fail(
      'probability-sum-not-one',
      `total is ${total}, which is not 1 within ${toleranceDecimal()}`,
    );
  }
  return { ok: true, value: record };
}

/** One level's value, or the class of problem it has. */
function readProbability(
  raw: unknown,
): number | 'not-a-number' | 'not-finite' | 'negative' {
  if (typeof raw !== 'number') return 'not-a-number';
  if (!Number.isFinite(raw)) return 'not-finite';
  return raw < 0 ? 'negative' : raw;
}

/** Turn a level's problem class into a bounded, non-echoing failure. */
function failProbability(
  problem: 'not-a-number' | 'not-finite' | 'negative',
  key: string,
): Either<ScoreDistribution> {
  if (problem === 'negative') {
    return fail('probability-negative', `level ${key} is negative`);
  }
  return fail(
    'probability-not-finite',
    problem === 'not-finite'
      ? `level ${key} is not finite`
      : `level ${key} does not hold a number`,
  );
}

/** The cumulative mass through one native level, inclusive. */
export function cumulative(
  distribution: ScoreDistribution,
  level: number,
): number {
  return Number(cumulativeDecimal(distribution, level, 0));
}

/**
 * The cumulative mass in integer units, so a comparison against one half is exact.
 *
 * Adding floats can turn an exact half into 0.5000000000000001 or
 * 0.49999999999999994 depending on the order of the terms, which is precisely the
 * distinction N0 depends on.
 */
function cumulativeDecimal(
  distribution: ScoreDistribution,
  level: number,
  base: 0 | 1,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(distribution)) {
    const index = Number(key);
    if (index < base || index > level) continue;
    const exact = exactDecimal(value);
    if (exact === null) {
      // Validation accepts only finite values, so this is unreachable for an
      // accepted distribution. Refusing loudly beats contributing an implicit
      // zero, which would silently change the median.
      throw new RangeError(`level ${key} has no exact decimal form`);
    }
    parts.push(exact);
  }
  return addDecimals(parts);
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
  for (let level = base; level <= highest; level += 1) {
    // Exact decimals throughout: an exact half must stay exactly half, or the two
    // rules would agree where the contract says they must differ.
    const running = cumulativeDecimal(distribution, level, base);
    const comparison = compareToHalf(running);
    const reached = rule === 'risk' ? comparison > 0 : comparison >= 0;
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
  | {
      readonly ok: false;
      readonly failures: readonly ScoreFailure[];
      readonly diagnostic: {
        readonly risk: ScoreTrail | null;
        readonly authorization: ScoreTrail | null;
      };
    } {
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
  | {
      readonly ok: false;
      readonly failures: readonly ScoreFailure[];
      readonly diagnostic: {
        readonly risk: ScoreTrail | null;
        readonly authorization: ScoreTrail | null;
      };
    } {
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
  if (!risk.ok || !authorization.ok) {
    return {
      ok: false,
      failures,
      diagnostic: {
        risk: risk.ok ? pointTrail(risk.score) : null,
        authorization: authorization.ok
          ? pointTrail(authorization.score)
          : null,
      },
    };
  }
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
  | {
      readonly ok: false;
      readonly failures: readonly ScoreFailure[];
      readonly diagnostic: {
        readonly risk: ScoreTrail | null;
        readonly authorization: ScoreTrail | null;
      };
    } {
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
  if (!risk.ok || !authorization.ok) {
    // The half that did read is kept as diagnostic evidence; the half that did not
    // stays null rather than being guessed at.
    return {
      ok: false,
      failures,
      diagnostic: {
        risk: risk.ok ? distributionTrail(risk.value, 'risk') : null,
        authorization: authorization.ok
          ? distributionTrail(authorization.value, 'authorization')
          : null,
      },
    };
  }
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

/**
 * A non-echoing description of an unexpected value.
 *
 * It names the *kind* only. Echoing the submitted value would copy provider output
 * into an error field, a review reason and the audit record — and that output can
 * contain a credential the provider repeated from its own prompt.
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'boolean') return 'a boolean';
  return typeof value;
}
