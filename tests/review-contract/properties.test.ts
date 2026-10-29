/**
 * The properties the contract claims, checked over generated inputs rather than
 * examples: first-order stochastic dominance, chat identity, and the two
 * monotonicities of the matrix.
 *
 * Examples prove a value; properties prove the rule survives inputs nobody thought
 * to write down. Each generator below is constrained to *legal* inputs, because the
 * contract's obligation for illegal input is rejection, which the unit tests cover.
 */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  bandFromNative,
  chatScore,
  readProtocolScores,
  verdictFor,
} from '../../src/review-contract/index.js';
import { score } from '../helpers/score.js';

/** A probability vector over ten native levels that sums to exactly one. */
const legalDistribution = (): fc.Arbitrary<Record<string, number>> =>
  fc
    .array(fc.integer({ min: 0, max: 1_000 }), {
      minLength: 10,
      maxLength: 10,
    })
    .map((weights) => {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const out: Record<string, number> = {};
      // A zero total is not a distribution; fall back to a point mass so the
      // generator only ever produces legal input.
      if (total === 0) {
        for (let level = 0; level <= 9; level += 1) {
          out[String(level)] = level === 0 ? 1 : 0;
        }
        return out;
      }
      for (const [level, weight] of weights.entries()) {
        out[String(level)] = weight / total;
      }
      return out;
    });

/** Move mass from a lower level to a higher one: the FOSD-style step. */
function shiftUp(
  distribution: Record<string, number>,
  from: number,
  to: number,
  amount: number,
): Record<string, number> {
  const out = { ...distribution };
  out[String(from)] = (out[String(from)] ?? 0) - amount;
  out[String(to)] = (out[String(to)] ?? 0) + amount;
  return out;
}

describe('first-order stochastic dominance', () => {
  test('shifting mass upward never lowers the band', () => {
    // If one distribution puts at least as much mass at or above every level as
    // another, its band cannot be lower. The generator builds exactly that pair,
    // so the comparison is a genuine dominance relation, not a coincidence.
    fc.assert(
      fc.property(
        legalDistribution(),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 9 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (distribution, lowIndex, highIndex, fraction) => {
          const from = Math.min(lowIndex, highIndex - 1);
          const to = Math.max(highIndex, from + 1);
          const available = distribution[String(from)] ?? 0;
          if (available <= 0) return true;
          const shifted = shiftUp(distribution, from, to, available * fraction);
          for (const rule of ['risk', 'authorization'] as const) {
            expect(bandFromNative(shifted, rule)).toBeGreaterThanOrEqual(
              bandFromNative(distribution, rule),
            );
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  test('a band is always between one and ten', () => {
    fc.assert(
      fc.property(legalDistribution(), (distribution) => {
        for (const rule of ['risk', 'authorization'] as const) {
          const band = bandFromNative(distribution, rule);
          expect(band).toBeGreaterThanOrEqual(1);
          expect(band).toBeLessThanOrEqual(10);
          expect(Number.isInteger(band)).toBe(true);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('chat identity', () => {
  test('every legal chat score maps to itself', () => {
    // Identity is the contract, so a generator over the whole legal range is the
    // right check: any transformation would show up immediately.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (score) => {
        const result = chatScore(score);
        expect(result.ok).toBe(true);
        if (!result.ok) return false;
        expect(result.score).toBe(score);
        const read = readProtocolScores({
          source: 'chat',
          risk: score,
          authorization: score,
        });
        expect(read.ok).toBe(true);
        if (!read.ok) return false;
        expect(read.risk).toBe(score);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  test('an integer outside the range is never accepted', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000, max: 0 }),
          fc.integer({ min: 11, max: 1_000 }),
        ),
        (score) => {
          expect(chatScore(score).ok).toBe(false);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('matrix monotonicity', () => {
  const toScore = (value: number) => score(value);
  const rank = {
    'review-deny': 0,
    'review-escalate': 1,
    'review-allow': 2,
  } as const;

  test('authorization is upward closed at fixed risk', () => {
    // More coverage never turns an allow back into an escalation.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (risk, first, second) => {
          const low = Math.min(first, second);
          const high = Math.max(first, second);
          const lowRank = rank[verdictFor(toScore(risk), toScore(low))];
          const highRank = rank[verdictFor(toScore(risk), toScore(high))];
          expect(highRank).toBeGreaterThanOrEqual(lowRank);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  test('risk is downward closed at fixed authorization', () => {
    // More risk never turns an escalation back into an allow. Column 1 is excluded
    // because it denies on its own authorization rather than on risk.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (authorization, first, second) => {
          const low = Math.min(first, second);
          const high = Math.max(first, second);
          const lowRank =
            rank[verdictFor(toScore(low), toScore(authorization))];
          const highRank =
            rank[verdictFor(toScore(high), toScore(authorization))];
          expect(highRank).toBeLessThanOrEqual(lowRank);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  test('an allow always means the threshold was reached', () => {
    // The matrix and its own threshold function must agree for every pair, or a
    // caller reading `requiredAuthorization` would explain a different verdict.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (risk, authorization) => {
          const verdict = verdictFor(toScore(risk), toScore(authorization));
          const threshold = risk <= 2 ? 2 : risk <= 4 ? 8 : risk <= 6 ? 9 : 10;
          // Collect the facts and assert once, so a counterexample reports the
          // whole pair rather than the first failing clause.
          const allowImpliesThreshold =
            verdict !== 'review-allow' || authorization >= threshold;
          const denyImpliesProhibition =
            (verdict === 'review-deny') === (authorization === 1);
          expect(allowImpliesThreshold && denyImpliesProhibition).toBe(true);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('protocol parity', () => {
  test('one public answer decides the same from both protocols', () => {
    // A decision distribution with all its mass on one native level states exactly
    // the same thing as the equivalent chat integer, so the verdicts must match.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        (riskLevel, authLevel) => {
          const point = (level: number) => {
            const out: Record<string, number> = {};
            for (let index = 0; index <= 9; index += 1) {
              out[String(index)] = index === level ? 1 : 0;
            }
            return out;
          };
          const chat = readProtocolScores({
            source: 'chat',
            risk: riskLevel + 1,
            authorization: authLevel + 1,
          });
          const decision = readProtocolScores({
            source: 'decision',
            risk: point(riskLevel),
            authorization: point(authLevel),
          });
          expect(chat.ok).toBe(true);
          expect(decision.ok).toBe(true);
          if (!chat.ok || !decision.ok) return false;
          expect(decision.risk).toBe(chat.risk);
          expect(decision.authorization).toBe(chat.authorization);
          expect(verdictFor(decision.risk, decision.authorization)).toBe(
            verdictFor(chat.risk, chat.authorization),
          );
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
