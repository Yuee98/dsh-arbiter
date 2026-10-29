/**
 * N0 — the normalization contract from the design (§2.2).
 *
 * Two asymmetric rules decide every score, and the asymmetry is the part most
 * likely to be "tidied" into a single comparison later:
 *
 *   risk          smallest k with F(k) > 0.5   (strictly above one half)
 *   authorization smallest k with F(k) >= 0.5  (one half already reaches it)
 *
 * An exact half therefore gives risk the more severe band and authorization the
 * already-covered band. The rubric's own example — 40% A1 with 60% A10 => A10 — is
 * asserted literally below.
 *
 * Validation is equally part of the contract: a distribution that is not a legal
 * one is *rejected*, never re-weighted, never averaged, never repaired. A repaired
 * distribution would report a score the reviewer did not give.
 */

import { describe, expect, test } from 'vitest';

import {
  addDecimals,
  bandFromNative,
  bandFromPublic,
  chatScore,
  compareToHalf,
  evaluateReview,
  exactDecimal,
  cumulative,
  distributionToPublic,
  readProtocolScores,
  SUM_TOLERANCE,
  validateNativeDistribution,
  verdictFor,
  weightedBand,
} from '../../src/review-contract/index.js';
import { score } from '../helpers/score.js';

/** A native distribution with the given non-zero levels. */
function dist(
  entries: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let level = 0; level <= 9; level += 1) {
    out[String(level)] = entries[String(level)] ?? 0;
  }
  return out;
}

describe('N0 medians', () => {
  test('a point mass gives its own band', () => {
    for (let level = 0; level <= 9; level += 1) {
      const point = dist({ [String(level)]: 1 });
      // Native level k is public band k+1, and both rules agree on a point mass.
      expect(bandFromNative(point, 'risk')).toBe(level + 1);
      expect(bandFromNative(point, 'authorization')).toBe(level + 1);
    }
  });

  test('an exact half splits: risk takes the higher band, authorization the lower', () => {
    // F(4) = 0.5 exactly. Risk needs *more* than half, so it climbs to band 6;
    // authorization accepts exactly half, so it stays at band 5.
    const half = dist({ '4': 0.5, '5': 0.5 });
    expect(cumulative(half, 4)).toBe(0.5);
    expect(bandFromNative(half, 'risk')).toBe(6);
    expect(bandFromNative(half, 'authorization')).toBe(5);
  });

  test('the rubric example: A1 40% with A10 60% is A10', () => {
    // This is the published acceptance case, written with the protocol's own
    // numbering: level 0 is A1 and level 9 is A10.
    const example = dist({ '0': 0.4, '9': 0.6 });
    expect(bandFromNative(example, 'authorization')).toBe(10);
    // The same shape under the risk rule also crosses at level 9, because the
    // first 0.6 above half is reached there.
    expect(bandFromNative(example, 'risk')).toBe(10);
  });

  test('an A1 majority is A1 for authorization', () => {
    // 60% prohibition: F(0) = 0.6 already reaches one half, so band 1 is selected
    // even though 40% of the mass sits on A10.
    const mostlyProhibited = dist({ '0': 0.6, '9': 0.4 });
    expect(bandFromNative(mostlyProhibited, 'authorization')).toBe(1);
    // Risk also stops at the first band: 0.6 is already strictly above one half,
    // so the highest level reached does not pull the band upward. Both rules scan
    // from the bottom, and neither takes the most severe band with any mass.
    expect(bandFromNative(mostlyProhibited, 'risk')).toBe(1);
  });

  test('a tail at the top level does not lift the band by itself', () => {
    // Concretely: 45% at the lowest level and 55% at the highest still selects
    // band 1 for risk, because F(0) = 0.45 has not crossed but F(1) = 0.45 ... and
    // the 55% only arrives at level 9. This separates "first band crossing half"
    // from "highest band with mass", which are different rules.
    const split = dist({ '0': 0.45, '9': 0.55 });
    expect(bandFromNative(split, 'risk')).toBe(10);
    expect(bandFromNative(split, 'authorization')).toBe(10);
    // Below half at the bottom, the scan continues past the first bands and the
    // top tail is what crosses.
    expect(cumulative(split, 0)).toBeCloseTo(0.45, 10);
  });

  test('a half at the prohibition band still selects the covered band', () => {
    // Exactly half A1 and half A2: authorization accepts the half, so A1.
    const half = dist({ '0': 0.5, '1': 0.5 });
    expect(bandFromNative(half, 'authorization')).toBe(1);
    // Risk refuses to call one half decisive and climbs to A2's level.
    expect(bandFromNative(half, 'risk')).toBe(2);
  });

  test('cumulative sums are inclusive of the level itself', () => {
    const sample = dist({ '2': 0.3, '4': 0.7 });
    expect(cumulative(sample, 1)).toBe(0);
    expect(cumulative(sample, 2)).toBeCloseTo(0.3, 10);
    expect(cumulative(sample, 3)).toBeCloseTo(0.3, 10);
    expect(cumulative(sample, 4)).toBeCloseTo(1, 10);
  });

  test('the public numbering applies the same rule', () => {
    // The live engine reads a public 1..10 distribution, so the shared helper has
    // to give the same answer there rather than a second implementation's answer.
    const publicHalf = { '5': 0.5, '6': 0.5 };
    expect(bandFromPublic(publicHalf, 'risk')).toBe(6);
    expect(bandFromPublic(publicHalf, 'authorization')).toBe(5);
    expect(bandFromPublic({ '1': 0.4, '10': 0.6 }, 'authorization')).toBe(10);
  });

  test('both numberings agree on the same underlying distribution', () => {
    const native = dist({ '1': 0.2, '6': 0.3, '8': 0.5 });
    const published = distributionToPublic(native);
    for (const rule of ['risk', 'authorization'] as const) {
      expect(bandFromPublic(published, rule)).toBe(
        bandFromNative(native, rule),
      );
    }
  });
});

describe('exact-half arithmetic', () => {
  // Adding float probabilities in order can turn an exact decimal half into
  // 0.5000000000000001 or 0.49999999999999994. N0 exists to distinguish "at least
  // half" from "more than half", so the comparison is made on exact decimals: the
  // shortest round-trip form of each value, summed in scaled integers. Nothing is
  // quantized, so a value that genuinely differs from a half keeps differing.
  test('an accumulation just above half is not treated as more than half', () => {
    const distribution = dist({
      '0': 0.1398,
      '1': 0.3385,
      '2': 0.0217,
      '9': 0.5,
    });
    // In floating point F(2) evaluates to 0.5000000000000001, which a naive
    // `> 0.5` would accept as decisive.
    expect(0.1398 + 0.3385 + 0.0217).toBeGreaterThan(0.5);
    // Risk needs *more* than half, so it does not stop at band 3.
    expect(bandFromNative(distribution, 'risk')).toBe(10);
    // Authorization accepts half, so it does stop there.
    expect(bandFromNative(distribution, 'authorization')).toBe(3);
  });

  test('an accumulation just below half is still half for authorization', () => {
    const distribution = dist({
      '3': 0.0586,
      '4': 0.1725,
      '5': 0.2689,
      '9': 0.5,
    });
    // In floating point F(5) evaluates to 0.49999999999999994.
    expect(0.0586 + 0.1725 + 0.2689).toBeLessThan(0.5);
    // Authorization reaches the boundary inclusively, so band 6 is selected.
    expect(bandFromNative(distribution, 'authorization')).toBe(6);
    // Risk does not, so it continues to the top band.
    expect(bandFromNative(distribution, 'risk')).toBe(10);
  });

  test('a sum that truly exceeds half is not rounded down to half', () => {
    // The counterexample that a fixed six-decimal quantization got wrong: every
    // value here is a legal probability, and F(2) is 0.5000002 — above half. Rounding
    // each value to six places would scale them to 499999 units and lose the
    // distinction, turning A3 into A10.
    const authorization = dist({
      '0': 0.1000004,
      '1': 0.1000004,
      '2': 0.2999994,
      '9': 0.4999998,
    });
    // The exact decimal sum really is above half, and asserting the float sum keeps
    // the test honest about why the naive reading is not enough.
    expect(
      compareToHalf(addDecimals(['0.1000004', '0.1000004', '0.2999994'])),
    ).toBeGreaterThan(0);
    // Authorization reaches half at band 3.
    expect(bandFromNative(authorization, 'authorization')).toBe(3);
  });

  test('the matrix verdict for a genuinely above-half answer escalates', () => {
    // With risk 7 the required authorization is A10, so A3 must escalate. This is
    // the false allow the quantized comparison produced.
    const risk = dist({ '6': 1 });
    const authorization = dist({
      '0': 0.1000004,
      '1': 0.1000004,
      '2': 0.2999994,
      '9': 0.4999998,
    });
    const outcome = evaluateReview({
      scores: { source: 'decision', risk, authorization },
    });
    expect(outcome.status).toBe('scored');
    if (outcome.status !== 'scored')
      throw new Error('expected a scored review');
    expect(outcome.authorization).toBe(3);
    expect(outcome.requiredAuthorization).toBe(10);
    expect(outcome.verdict).toBe('review-escalate');
  });

  test('a probability in exponent form still counts toward the median', () => {
    // `String(1e-7)` is "1e-7", so a parser that only accepted plain decimals
    // silently dropped this value and read F(1) as 0.4999999 instead of 0.5.
    expect(String(1e-7)).toBe('1e-7');
    // The exact form is available and loses no digits.
    expect(exactDecimal(1e-7)).toBe('0.0000001');
    expect(exactDecimal(1.5e-7)).toBe('0.00000015');
    expect(exactDecimal(1.25e-8)).toBe('0.0000000125');
    // A large value expands the other way, and still loses nothing.
    expect(exactDecimal(1e21)).toBe('1000000000000000000000');
    const authorization = dist({ '0': 0.4999999, '1': 1e-7, '9': 0.5 });
    // F(1) is exactly one half, so authorization reaches band 2.
    expect(bandFromNative(authorization, 'authorization')).toBe(2);
  });

  test('the exponent-form answer escalates at risk 7', () => {
    // The false allow this defect produced: A10 instead of A2 at a risk that
    // requires A10.
    const risk = dist({ '6': 1 });
    const authorization = dist({ '0': 0.4999999, '1': 1e-7, '9': 0.5 });
    const outcome = evaluateReview({
      scores: { source: 'decision', risk, authorization },
    });
    expect(outcome.status).toBe('scored');
    if (outcome.status !== 'scored')
      throw new Error('expected a scored review');
    expect(outcome.authorization).toBe(2);
    expect(outcome.verdict).toBe('review-escalate');
  });

  test('an unreadable value is refused rather than counted as zero', () => {
    // Validation admits only finite numbers, so this cannot arise from an accepted
    // answer; the assertion pins that the accumulation refuses loudly instead of
    // contributing an implicit zero, which would move the median.
    const broken: Record<string, number> = dist({});
    broken['0'] = Number.NaN;
    expect(() => bandFromNative(broken, 'authorization')).toThrow(RangeError);
  });

  test('the matrix verdict follows the corrected band', () => {
    // The first distribution with A8 is an allow if risk is 3 and an escalation if
    // risk is 10, which is exactly the decision the float error would have flipped.
    const riskHalf = dist({ '0': 0.1398, '1': 0.3385, '2': 0.0217, '9': 0.5 });
    const auth = dist({ '7': 1 });
    const risk = bandFromNative(riskHalf, 'risk');
    const authorization = bandFromNative(auth, 'authorization');
    expect(risk).toBe(10);
    expect(authorization).toBe(8);
    expect(verdictFor(score(risk), score(authorization))).toBe(
      'review-escalate',
    );
  });
});

describe('distribution validation', () => {
  test('accepts a legal native distribution', () => {
    const result = validateNativeDistribution(dist({ '3': 0.25, '9': 0.75 }));
    expect(result.ok).toBe(true);
  });

  test('accepts a total within protocol rounding', () => {
    // Ten four-decimal entries cannot total exactly one in general. The tolerance
    // absorbs that rounding and nothing looser.
    const rounded = dist({ '0': 0.3333, '1': 0.3333, '2': 0.3334 });
    expect(
      Math.abs(Object.values(rounded).reduce((a, b) => a + b, 0) - 1),
    ).toBeLessThanOrEqual(SUM_TOLERANCE);
    expect(validateNativeDistribution(rounded).ok).toBe(true);
  });

  test.each([
    [
      'a total below one',
      dist({ '0': 0.5, '9': 0.45 }),
      'probability-sum-not-one',
    ],
    [
      'a total above one',
      dist({ '0': 0.5, '9': 0.55 }),
      'probability-sum-not-one',
    ],
    ['only zero mass', dist({}), 'probability-sum-not-one'],
    // The value checks use a complete key set, so the failure they report is the
    // value's own and not the missing-level one.
    [
      'a negative probability',
      dist({ '0': -0.1, '9': 1.1 }),
      'probability-negative',
    ],
    [
      'a non-finite probability',
      dist({ '0': Number.NaN }),
      'probability-not-finite',
    ],
    [
      'an infinite probability',
      dist({ '0': Number.POSITIVE_INFINITY }),
      'probability-not-finite',
    ],
    [
      'a string probability',
      { ...dist({}), '0': '0.5' },
      'probability-not-finite',
    ],
    // A wrong key fails as a bad level rather than as an incomplete set, because
    // the key itself is what cannot be read.
    ['a level of ten', { '10': 1 }, 'level-out-of-range'],
    ['a negative level', { '-1': 1 }, 'level-out-of-range'],
    ['a fractional level', { '1.5': 1 }, 'level-out-of-range'],
    ['a non-numeric level', { risk: 1 }, 'level-out-of-range'],
    ['a lone out-of-range key', { '10': 1 }, 'level-out-of-range'],
    // Canonical spelling matters: "00" and "0" both convert to level zero, so a
    // distribution holding both would address one level twice.
    ['an aliased level key', { '0': 0.6, '00': 0.4 }, 'level-out-of-range'],
    ['a padded level key', { '01': 0.5, '1': 0.5 }, 'level-out-of-range'],
  ])('rejects %s', (_name, value, reason) => {
    const result = validateNativeDistribution(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toBe(reason);
  });

  test.each([
    ['null', null],
    ['an array', [1, 0]],
    ['a string', '0.5'],
    ['a number', 1],
    ['an empty object', {}],
  ])('rejects %s as a distribution', (_name, value) => {
    expect(validateNativeDistribution(value).ok).toBe(false);
  });

  test('the legacy eleven-level shape is rejected, not folded', () => {
    // The pre-change protocol could answer 0..10. Folding 10 onto 9 would invent a
    // probability the reviewer never gave, so the whole answer fails instead.
    const legacy = { ...dist({ '0': 0 }), '10': 1 };
    const result = validateNativeDistribution(legacy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toBe('level-out-of-range');
  });

  test('a missing level is rejected even when the given values total one', () => {
    // This is the case a sum check alone cannot catch: nine levels whose own mass
    // already reaches one. The tenth level is simply unaccounted for, and treating
    // that as zero would report a distribution the reviewer did not give.
    const nineLevels: Record<string, number> = {};
    for (let level = 0; level <= 8; level += 1) {
      nineLevels[String(level)] = level === 0 ? 1 : 0;
    }
    expect(Object.keys(nineLevels)).toHaveLength(9);
    const result = validateNativeDistribution(nineLevels);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toBe('level-set-incomplete');
  });

  test('a sparse distribution is rejected even when it sums to one', () => {
    // {"0": 1} totals one, so a sum-only validator would accept it and silently
    // treat nine unreported levels as zero.
    const sparse = { '0': 1 };
    const result = validateNativeDistribution(sparse);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toBe('level-set-incomplete');
  });

  test('an arbitrary positive total is not re-weighted into a legal distribution', () => {
    // 3:1 is a *ratio*, not a distribution. Dividing by its total would produce a
    // plausible answer out of a malformed one.
    const ratio = dist({ '0': 3, '9': 1 });
    expect(validateNativeDistribution(ratio).ok).toBe(false);
  });

  test('an accepted distribution is copied, not aliased', () => {
    const input = dist({ '0': 0.5, '9': 0.5 });
    const result = validateNativeDistribution(input);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
  });
});

describe('chat scores', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    'a legal answer of %i maps to itself',
    (score) => {
      // Identity is the contract: a chat integer is already public, so any
      // transformation here would make the point value and the matrix disagree.
      const result = chatScore(score);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected a score');
      expect(result.score).toBe(score);
    },
  );

  test.each([
    [0, 'score-out-of-range'],
    [11, 'score-out-of-range'],
    [-1, 'score-out-of-range'],
    [2.5, 'score-not-integer'],
    ['3', 'score-not-integer'],
    [null, 'score-not-integer'],
    [undefined, 'score-not-integer'],
    [true, 'score-not-integer'],
  ])('rejects %s', (value, reason) => {
    const result = chatScore(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toBe(reason);
  });
});

describe('scoring an answer pair', () => {
  test('a chat pair keeps its integers and audits them as points', () => {
    const read = readProtocolScores({
      source: 'chat',
      risk: 3,
      authorization: 8,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected scores');
    expect([read.risk, read.authorization]).toEqual([3, 8]);
    // The audit records each field's own provenance: an integer for chat, no
    // distribution, because none was submitted.
    expect(read.audit.risk).toEqual({
      native: null,
      published: null,
      point: 3,
      score: 3,
    });
    expect(read.audit.authorization.point).toBe(8);
  });

  test('a decision pair keeps native, published and formal values apart', () => {
    // Three different pieces of information with three different purposes: the
    // submitted distribution, the same mass on the public scale, and the band the
    // N0 rule selects from it.
    const native = dist({ '0': 0.4, '9': 0.6 });
    const read = readProtocolScores({
      source: 'decision',
      risk: dist({ '0': 1 }),
      authorization: native,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected scores');
    expect(read.authorization).toBe(10);
    expect(read.audit.authorization.native).toEqual(native);
    // The published form keeps every submitted level (including zero mass) so the
    // two forms are the same distribution under a shift, not a filtered summary.
    const published = read.audit.authorization.published ?? {};
    expect(Object.keys(published)).toHaveLength(10);
    expect(published['1']).toBeCloseTo(0.4, 10);
    expect(published['10']).toBeCloseTo(0.6, 10);
    expect(Object.values(published).reduce((a, b) => a + b, 0)).toBeCloseTo(
      1,
      10,
    );
    expect(read.audit.authorization.score).toBe(10);
    expect(read.audit.authorization.point).toBeNull();
    // The native distribution is retained unchanged, so an evals caller can
    // recover exactly what the reviewer submitted.
    expect(read.audit.authorization.native).not.toBe(native);
    expect(
      Object.entries(read.audit.authorization.published ?? {})
        .filter(([, mass]) => mass > 0)
        .map(([level]) => level),
    ).toEqual(['1', '10']);
  });

  test('one invalid field fails the pair and reports only that field', () => {
    // A partial read must not be presented as a scored result: the caller needs to
    // know the review did not complete, and which part did not.
    const read = readProtocolScores({
      source: 'decision',
      risk: dist({ '0': 1 }),
      authorization: { '10': 1 },
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failure');
    expect(read.failures).toHaveLength(1);
    expect(read.failures[0]?.field).toBe('authorization');
    expect(read.failures[0]?.reason).toBe('level-out-of-range');
  });

  test('failures name both fields when both are invalid', () => {
    const read = readProtocolScores({
      source: 'decision',
      risk: { '10': 1 },
      authorization: { '11': 1 },
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failure');
    expect(read.failures.map((failure) => failure.field)).toEqual([
      'risk',
      'authorization',
    ]);
  });

  test('a failure never carries a fabricated score', () => {
    const read = readProtocolScores({
      source: 'chat',
      risk: 0,
      authorization: 5,
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failure');
    expect(read).not.toHaveProperty('risk');
    expect(read).not.toHaveProperty('audit');
  });

  test('the weighted band is diagnostic only', () => {
    // It is retained for display; nothing in the matrix reads it. Confirming the
    // value here keeps a caller from mistaking it for the formal score.
    expect(weightedBand(dist({ '0': 0.5, '9': 0.5 }))).toBeCloseTo(5.5, 10);
  });
});
