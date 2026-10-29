/**
 * The three outcomes are genuinely different states, not three spellings of "not
 * allowed", and each takes its own escalation path:
 *
 *   scored                — the reviewer answered and the matrix decided
 *   insufficient-material — the answer is fine but the material behind it is not
 *   review-failure        — the answer, its transport or its shape failed
 *
 * The tests below pin the differences that matter operationally: an incomplete
 * review never becomes a verdict, a malformed answer never becomes a score, and a
 * partial answer still reports what could be read without pretending it was enough.
 */

import { describe, expect, test } from 'vitest';

import {
  evaluateReview,
  materialAvailability,
  outcomeStatus,
  reviewFailure,
  summarizeFailures,
} from '../../src/review-contract/index.js';
import type {
  PublicScore,
  ReviewOutcome,
} from '../../src/review-contract/index.js';
import { score } from '../helpers/score.js';

const SCORE = (value: number): PublicScore => score(value);

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

/** The scored outcome, or a test failure when another status came back. */
function scored(outcome: ReviewOutcome) {
  if (outcome.status !== 'scored') {
    throw new Error(`expected a scored review, received ${outcome.status}`);
  }
  return outcome;
}

describe('a scored review', () => {
  test('applies the matrix and retains the audit trail', () => {
    const outcome = scored(
      evaluateReview({
        scores: { source: 'chat', risk: 5, authorization: 9 },
      }),
    );
    expect(outcome.verdict).toBe('review-allow');
    expect(outcome.requiredAuthorization).toBe(9);
    expect(outcome.source).toBe('chat');
    expect(outcome.audit.risk.score).toBe(5);
  });

  test('an absent material field means nothing was reported missing', () => {
    // The collector omits the field when it found no gap, so absence must not be
    // read as "unknown material" — that would escalate every ordinary review.
    const outcome = evaluateReview({
      scores: { source: 'chat', risk: 1, authorization: 2 },
    });
    expect(outcome.status).toBe('scored');
  });

  test('A1 denies at the lowest risk', () => {
    const outcome = scored(
      evaluateReview({
        scores: { source: 'chat', risk: 1, authorization: 1 },
      }),
    );
    expect(outcome.verdict).toBe('review-deny');
  });
});

describe('insufficient material', () => {
  test('escalates without inventing a verdict', () => {
    const outcome = evaluateReview({
      scores: { source: 'chat', risk: 3, authorization: 8 },
      material: materialAvailability([
        { source: 'project rules', reason: 'read failed' },
      ]),
    });
    expect(outcome.status).toBe('insufficient-material');
    if (outcome.status !== 'insufficient-material')
      throw new Error('expected insufficient material');
    expect(outcome.gaps).toEqual([
      { source: 'project rules', reason: 'read failed' },
    ]);
    // The reviewer's own numbers are kept for diagnosis, but they are not a
    // verdict: the material that would justify one is what is missing.
    expect(outcome.diagnostic).toEqual({ risk: 3, authorization: 8 });
    expect(outcome).not.toHaveProperty('verdict');
    expect(outcome).not.toHaveProperty('requiredAuthorization');
  });

  test('names each gap source and reason', () => {
    const outcome = evaluateReview({
      scores: { source: 'chat', risk: 3, authorization: 8 },
      material: materialAvailability([
        { source: 'project rules', reason: 'read failed' },
        { source: 'parent session', reason: 'not available' },
      ]),
    });
    if (outcome.status !== 'insufficient-material')
      throw new Error('expected insufficient material');
    expect(outcome.reason).toContain('project rules');
    expect(outcome.reason).toContain('read failed');
    expect(outcome.reason).toContain('parent session');
  });

  test('an empty gap list is still a gap, not an available material', () => {
    // `materialAvailability([])` reports availability; an explicit empty gap list
    // built by hand must not silently select the scored path.
    const outcome = evaluateReview({
      scores: { source: 'chat', risk: 1, authorization: 2 },
      material: { status: 'insufficient', gaps: [] },
    });
    expect(outcome.status).toBe('insufficient-material');
  });

  test('a malformed answer takes the failure path, not the material path', () => {
    // Order matters: an unreadable answer is a failure even when material is also
    // missing, because there is nothing to diagnose.
    const outcome = evaluateReview({
      scores: { source: 'chat', risk: 0, authorization: 8 },
      material: materialAvailability([{ source: 'x', reason: 'y' }]),
    });
    expect(outcome.status).toBe('review-failure');
  });
});

describe('review failure', () => {
  test('reports every rejected field with its reason class', () => {
    const outcome = evaluateReview({
      scores: {
        source: 'decision',
        risk: { '10': 1 },
        authorization: { '0': 0.5 },
      },
    });
    expect(outcome.status).toBe('review-failure');
    if (outcome.status !== 'review-failure')
      throw new Error('expected a failure');
    expect(outcome.failures.map((failure) => failure.field)).toEqual([
      'risk',
      'authorization',
    ]);
    expect(outcome.failures.map((failure) => failure.reason)).toEqual([
      'level-out-of-range',
      'probability-sum-not-one',
    ]);
    expect(outcome.reason).toContain('risk');
  });

  test('a call-level failure carries its error and fabricates no score', () => {
    const outcome = reviewFailure('the decision backend timed out');
    expect(outcome.status).toBe('review-failure');
    expect(outcome.reason).toBe('the decision backend timed out');
    expect(outcome.failures).toEqual([]);
    expect(outcome).not.toHaveProperty('risk');
    expect(outcome).not.toHaveProperty('audit');
  });

  test('the summary names fields and reasons without quoting the answer', () => {
    // The handoff text is shown to a person and may travel into an audit record,
    // so it must not carry the reviewer's raw output, which can quote the material
    // under review.
    const text = summarizeFailures([
      {
        field: 'risk',
        reason: 'probability-sum-not-one',
        detail: 'total is 0.950000, which is not 1 within 0.0001',
      },
    ]);
    expect(text).toContain('risk');
    expect(text).toContain('probability-sum-not-one');
    expect(text).not.toContain('{"');
  });

  test('an empty failure list still reads as a failure', () => {
    expect(summarizeFailures([])).toContain('no usable score');
  });
});

describe('no backend branch', () => {
  test('the same scores decide the same way from either protocol', () => {
    // The acceptance condition is that one public input and configuration reach
    // one verdict. Only the audit trail may differ, because the protocols report
    // their evidence differently.
    const chat = scored(
      evaluateReview({
        scores: { source: 'chat', risk: 6, authorization: 9 },
      }),
    );
    const decision = scored(
      evaluateReview({
        scores: {
          source: 'decision',
          risk: dist({ '5': 1 }),
          authorization: dist({ '8': 1 }),
        },
      }),
    );
    expect(decision.risk).toBe(chat.risk);
    expect(decision.authorization).toBe(chat.authorization);
    expect(decision.verdict).toBe(chat.verdict);
    expect(decision.requiredAuthorization).toBe(chat.requiredAuthorization);
    // The trails differ: chat has points, decision has distributions.
    expect(chat.audit.risk.point).toBe(6);
    expect(decision.audit.risk.point).toBeNull();
    expect(decision.audit.risk.native).not.toBeNull();
  });

  test('the scored source is recorded so a reader knows the protocol', () => {
    expect(
      scored(
        evaluateReview({
          scores: { source: 'chat', risk: 1, authorization: 2 },
        }),
      ).source,
    ).toBe('chat');
    expect(
      scored(
        evaluateReview({
          scores: {
            source: 'decision',
            risk: dist({ '0': 1 }),
            authorization: dist({ '1': 1 }),
          },
        }),
      ).source,
    ).toBe('decision');
  });
});

describe('outcome status helper', () => {
  test('reports the discriminated status unchanged', () => {
    const failure = reviewFailure('boom');
    expect(outcomeStatus(failure)).toBe('review-failure');
    expect(
      outcomeStatus(
        evaluateReview({
          scores: { source: 'chat', risk: SCORE(1), authorization: SCORE(2) },
        }),
      ),
    ).toBe('scored');
  });
});
