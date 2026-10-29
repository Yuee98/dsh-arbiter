/**
 * The shared matrix, all one hundred cells, against expectations written out by
 * hand rather than computed from the implementing rule.
 *
 * The grid below is the acceptance criterion from #65: every risk and
 * authorization pair, with no extra risk cap. A test that recomputed
 * `requiredAuthorizationFor` would only prove the function agrees with itself, so
 * each row is a literal string here.
 *
 * Legend: D = deny, E = escalate, A = allow.
 */

import { describe, expect, test } from 'vitest';

import {
  scoreReview,
  settle,
  verdictFor,
  requiredAuthorizationFor,
} from '../../src/review-contract/index.js';
import type { ReviewStage } from '../../src/review-contract/index.js';
import { letters, score } from '../helpers/score.js';

/**
 * The matrix, risk 1..10 down and authorization 1..10 across.
 *
 * Read a row as: at this risk, the weakest authorization that still permits the
 * action is the first `A`; everything below it escalates, and column 1 always
 * denies because it is an effective prohibition rather than a weak authorization.
 */
const GRID: readonly string[] = [
  'DAAAAAAAAA', // risk 1  -> A2..A10 allow (9 A)
  'DAAAAAAAAA', // risk 2  -> A2..A10 allow
  'DEEEEEEAAA', // risk 3  -> A2..A7 escalate (6 E), A8..A10 allow (3 A)
  'DEEEEEEAAA', // risk 4  -> same as risk 3
  'DEEEEEEEAA', // risk 5  -> A2..A8 escalate (7 E), A9..A10 allow (2 A)
  'DEEEEEEEAA', // risk 6  -> same as risk 5
  'DEEEEEEEEA', // risk 7  -> A2..A9 escalate (8 E), A10 allows (1 A)
  'DEEEEEEEEA', // risk 8  -> same as risk 7
  'DEEEEEEEEA', // risk 9  -> same as risk 7
  'DEEEEEEEEA', // risk 10 -> same as risk 7
];

const VERDICT_LETTER: Readonly<Record<string, string>> = {
  'review-deny': 'D',
  'review-escalate': 'E',
  'review-allow': 'A',
};

describe('the shared matrix across all one hundred cells', () => {
  test('the grid itself is the documented shape', () => {
    // Guards the table above: ten rows of ten columns, each starting with D and
    // with no A followed by an E (authorization is monotone at fixed risk).
    expect(GRID).toHaveLength(10);
    for (const [index, row] of GRID.entries()) {
      expect(row, `row ${String(index + 1)} length`).toHaveLength(10);
      expect(row[0], `row ${String(index + 1)} column 1`).toBe('D');
      expect(row.slice(1)).toMatch(/^E*A*$/u);
    }
    // The tally is independent evidence that all one hundred cells are covered:
    // one deny column, plus the two bands' worth of allows and escalates.
    const allows = GRID.reduce(
      (sum, row) => sum + letters(row).filter((cell) => cell === 'A').length,
      0,
    );
    const escalates = GRID.reduce(
      (sum, row) => sum + letters(row).filter((cell) => cell === 'E').length,
      0,
    );
    const denies = GRID.reduce(
      (sum, row) => sum + letters(row).filter((cell) => cell === 'D').length,
      0,
    );
    expect([denies, escalates, allows]).toEqual([10, 58, 32]);
    expect(denies + escalates + allows).toBe(100);
  });

  test.each(Array.from({ length: 10 }, (_, index) => [index + 1] as const))(
    'risk %i matches every authorization cell',
    (risk) => {
      const row = GRID[risk - 1] ?? '';
      const observed: string[] = [];
      for (let authorization = 1; authorization <= 10; authorization += 1) {
        // Every verdict has a letter in the table, so the lookup is total.
        const verdict = verdictFor(score(risk), score(authorization));
        observed.push(VERDICT_LETTER[verdict] ?? '?');
      }
      // One assertion per row keeps the failure readable as the whole row.
      expect(observed.join('')).toBe(row);
    },
  );

  test('column 1 denies at every risk, including the lowest', () => {
    // A1 is a prohibition, so the low-risk fast path that would otherwise allow a
    // risk-1 call must not apply. This is the case the live engine got wrong.
    for (let risk = 1; risk <= 10; risk += 1) {
      expect(verdictFor(score(risk), score(1))).toBe('review-deny');
    }
  });

  test('A2 permits only the two lowest risk bands', () => {
    expect(verdictFor(score(1), score(2))).toBe('review-allow');
    expect(verdictFor(score(2), score(2))).toBe('review-allow');
    for (let risk = 3; risk <= 10; risk += 1) {
      expect(verdictFor(score(risk), score(2))).toBe('review-escalate');
    }
  });

  test('A10 permits every risk band', () => {
    // Full coverage is enough at any risk; there is no policy ceiling above it.
    for (let risk = 1; risk <= 10; risk += 1) {
      expect(verdictFor(score(risk), score(10))).toBe('review-allow');
    }
  });

  test('authorization is monotone at fixed risk', () => {
    // More coverage never makes a verdict worse. The grid check above proves this
    // for the table; this states the property so a future table edit cannot
    // quietly invert it in the middle.
    for (let risk = 1; risk <= 10; risk += 1) {
      // Deny is the lowest, so a column that starts denying and then escalates
      // would fail the comparison rather than being normalised away.
      const rank = (verdict: string): number =>
        verdict === 'review-allow' ? 2 : verdict === 'review-escalate' ? 1 : 0;
      let previous = 0;
      for (let authorization = 1; authorization <= 10; authorization += 1) {
        const current = rank(verdictFor(score(risk), score(authorization)));
        expect(
          current,
          `risk ${String(risk)} at A${String(authorization)}`,
        ).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });

  test('risk is monotone at fixed authorization', () => {
    // Higher risk never makes a verdict better. Deny is excluded from the
    // comparison because column 1 denies on its own authorization, not on risk.
    for (let authorization = 2; authorization <= 10; authorization += 1) {
      const rank = (verdict: string): number =>
        verdict === 'review-allow' ? 2 : verdict === 'review-escalate' ? 1 : 0;
      let previous = 3;
      for (let risk = 1; risk <= 10; risk += 1) {
        const current = rank(verdictFor(score(risk), score(authorization)));
        expect(
          current,
          `A${String(authorization)} at risk ${String(risk)}`,
        ).toBeLessThanOrEqual(previous);
        previous = current;
      }
    }
  });

  test('there is no second risk ceiling', () => {
    // The acceptance condition is explicit: no additional risk cap. A10 permits
    // risk 10, and nothing above A10 is required to permit it.
    expect(requiredAuthorizationFor(score(10))).toBe(10);
    expect(verdictFor(score(10), score(10))).toBe('review-allow');
  });
});

describe('settlement of each matrix outcome', () => {
  const cases: readonly {
    readonly stage: ReviewStage;
    readonly ask: 'ask' | 'no-ask';
    readonly channel: 'available' | 'unavailable';
    readonly expected: string;
  }[] = [
    {
      stage: 'review-allow',
      ask: 'ask',
      channel: 'available',
      expected: 'allow',
    },
    {
      stage: 'review-allow',
      ask: 'no-ask',
      channel: 'available',
      expected: 'allow',
    },
    {
      stage: 'review-allow',
      ask: 'ask',
      channel: 'unavailable',
      expected: 'allow',
    },
    {
      stage: 'review-deny',
      ask: 'ask',
      channel: 'available',
      expected: 'deny',
    },
    {
      stage: 'review-deny',
      ask: 'no-ask',
      channel: 'available',
      expected: 'deny',
    },
    {
      stage: 'review-deny',
      ask: 'no-ask',
      channel: 'unavailable',
      expected: 'deny',
    },
    {
      stage: 'review-escalate',
      ask: 'ask',
      channel: 'available',
      expected: 'ask-human',
    },
    {
      stage: 'review-escalate',
      ask: 'no-ask',
      channel: 'available',
      expected: 'fallback-deny',
    },
    {
      stage: 'review-escalate',
      ask: 'ask',
      channel: 'unavailable',
      expected: 'fallback-deny',
    },
    {
      stage: 'error-escalate',
      ask: 'ask',
      channel: 'available',
      expected: 'ask-human',
    },
    {
      stage: 'error-escalate',
      ask: 'no-ask',
      channel: 'available',
      expected: 'fallback-deny',
    },
    {
      stage: 'error-escalate',
      ask: 'ask',
      channel: 'unavailable',
      expected: 'fallback-deny',
    },
  ];

  test.each(cases)(
    '$stage under $ask with channel $channel settles as $expected',
    ({ stage, ask, channel, expected }) => {
      const settlement = settle(
        stage,
        ask,
        channel === 'available'
          ? { status: 'available' }
          : { status: 'unavailable', reason: 'no approval channel' },
        'reason text',
      );
      expect(settlement.kind).toBe(expected);
    },
  );

  test('an escalation keeps the stage it came from', () => {
    // The stage and the settlement are different facts: a timeout that reaches a
    // person is still an error escalation, and the handoff can say so.
    const timeout = settle(
      'error-escalate',
      'ask',
      { status: 'available' },
      'the decision backend timed out',
    );
    expect(timeout.kind).toBe('ask-human');
    if (timeout.kind !== 'ask-human') throw new Error('expected an ask');
    expect(timeout.stage).toBe('error-escalate');
    expect(timeout.reason).toContain('timed out');

    const insufficient = settle(
      'review-escalate',
      'ask',
      { status: 'available' },
      'authorization could not be established',
    );
    if (insufficient.kind !== 'ask-human') throw new Error('expected an ask');
    expect(insufficient.stage).toBe('review-escalate');
  });

  test('a fallback keeps the stage and the reason too', () => {
    const fallback = settle(
      'error-escalate',
      'no-ask',
      { status: 'available' },
      'the reviewer failed',
    );
    expect(fallback.kind).toBe('fallback-deny');
    if (fallback.kind !== 'fallback-deny')
      throw new Error('expected a fallback');
    expect(fallback.stage).toBe('error-escalate');
    expect(fallback.reason).toBe('the reviewer failed');
  });

  test('a scored review carries its own threshold and verdict', () => {
    const scored = scoreReview(5, 9, {
      source: 'chat',
      audit: {
        risk: { native: null, published: null, point: 5, score: 5 },
        authorization: { native: null, published: null, point: 9, score: 9 },
      },
    });
    expect(scored.requiredAuthorization).toBe(9);
    expect(scored.verdict).toBe('review-allow');
    expect(scored.status).toBe('scored');
  });
});
