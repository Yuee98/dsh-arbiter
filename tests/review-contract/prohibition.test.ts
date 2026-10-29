/**
 * The prohibition check reads two shapes and answers one question: does this
 * answer state an effective prohibition?
 *
 * It matters because the live engine uses it before its own thresholds. The two
 * shapes are not interchangeable — chat reports a public integer, the decision
 * adapter publishes a distribution already re-keyed to 1..10 — and the legacy
 * `authClass` label is deliberately unused, since its `none` bucket covers both
 * "an effective prohibition" (denies) and "no permission at all" (allows at low
 * risk).
 */

import { describe, expect, test } from 'vitest';

import {
  authorizationLevel,
  isProhibited,
} from '../../src/review-contract/index.js';

/** A public (1..10) distribution with the given non-zero levels. */
function dist(
  entries: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let level = 1; level <= 10; level += 1) {
    out[String(level)] = entries[String(level)] ?? 0;
  }
  return out;
}

describe('reading a chat answer', () => {
  test('a public integer is its own level', () => {
    for (let score = 1; score <= 10; score += 1) {
      const level = authorizationLevel({ point: score, distribution: null });
      expect(level.ok).toBe(true);
      if (!level.ok) throw new Error('expected a level');
      expect(level.score).toBe(score);
    }
  });

  test('only band 1 is a prohibition', () => {
    expect(isProhibited({ point: 1, distribution: null })).toBe(true);
    // A2 allows at low risk, so it must not read as a prohibition even though the
    // legacy label for both was `none`.
    expect(isProhibited({ point: 2, distribution: null })).toBe(false);
    for (let score = 3; score <= 10; score += 1) {
      expect(isProhibited({ point: score, distribution: null })).toBe(false);
    }
  });

  test('an out-of-range point is unreadable rather than a prohibition', () => {
    // A broken answer must keep its own failure path; guessing it is a refusal
    // would deny calls on the strength of a malformed number.
    for (const point of [0, 11, 2.5]) {
      const level = authorizationLevel({ point, distribution: null });
      expect(level.ok).toBe(false);
      expect(isProhibited({ point, distribution: null })).toBe(false);
    }
  });
});

describe('reading a decision distribution', () => {
  test('the lower median decides, on the published scale', () => {
    // 60% at band 1 reaches one half immediately, so the answer is A1 even though
    // 40% sits at A10. A tail-based test would miss this.
    const mostlyProhibited = dist({ '1': 0.6, '10': 0.4 });
    const level = authorizationLevel({
      point: null,
      distribution: mostlyProhibited,
    });
    expect(level.ok).toBe(true);
    if (!level.ok) throw new Error('expected a level');
    expect(level.score).toBe(1);
    expect(isProhibited({ point: null, distribution: mostlyProhibited })).toBe(
      true,
    );
  });

  test('a minority prohibition is not a prohibition', () => {
    // 40% at band 1 with 60% at A10: the median lands on A10, so this is full
    // coverage, not a refusal. This is the published A1/A10 example.
    const mostlyCovered = dist({ '1': 0.4, '10': 0.6 });
    const level = authorizationLevel({
      point: null,
      distribution: mostlyCovered,
    });
    if (!level.ok) throw new Error('expected a level');
    expect(level.score).toBe(10);
    expect(isProhibited({ point: null, distribution: mostlyCovered })).toBe(
      false,
    );
  });

  test('an exact half at band 1 still selects band 1', () => {
    const half = dist({ '1': 0.5, '2': 0.5 });
    const level = authorizationLevel({ point: null, distribution: half });
    if (!level.ok) throw new Error('expected a level');
    expect(level.score).toBe(1);
    expect(isProhibited({ point: null, distribution: half })).toBe(true);
  });

  test.each([
    ['a total below one', { '1': 0.5, '10': 0.45 }],
    ['an out-of-range level', { '11': 1 }],
    ['a negative probability', { '1': -0.1, '10': 1.1 }],
    ['an empty distribution', {}],
  ])(
    'an invalid distribution (%s) is unreadable, not a prohibition',
    (_n, value) => {
      const level = authorizationLevel({ point: null, distribution: value });
      expect(level.ok).toBe(false);
      expect(isProhibited({ point: null, distribution: value })).toBe(false);
    },
  );

  test('native keys are not accepted on this path', () => {
    // The published distribution is 1..10. A native 0..9 object reaching this
    // helper would silently read the prohibition band as A1 only if 0 were
    // accepted, so it is rejected instead.
    const native = { '0': 0.6, '9': 0.4 };
    const level = authorizationLevel({ point: null, distribution: native });
    expect(level.ok).toBe(false);
  });
});

describe('neither shape', () => {
  test('a chat source with no point and no distribution is unreadable', () => {
    const level = authorizationLevel({ point: null, distribution: null });
    expect(level.ok).toBe(false);
    if (level.ok) throw new Error('expected a rejection');
    expect(level.reason).toContain('no authorization signal');
    expect(isProhibited({ point: null, distribution: null })).toBe(false);
  });

  test('a point takes precedence when both are present', () => {
    // A caller that supplies both is read as chat, which is what its source says;
    // the distribution is the decision shape and cannot arrive with a point.
    const level = authorizationLevel({
      point: 2,
      distribution: dist({ '1': 1 }),
    });
    if (!level.ok) throw new Error('expected a level');
    expect(level.score).toBe(2);
  });
});
