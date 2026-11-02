import { describe, expect, it } from 'vitest';
import {
  evaluateReview,
  matrixPolicy,
  scoreReview,
  verdictFor,
} from '../../src/review-contract/index.js';
import { score } from '../helpers/score.js';

describe('explicit shared matrix policy', () => {
  it('changes authorization demand and behaviour without changing the scores', () => {
    const policy = matrixPolicy([2, 2, 9, 9, 9, 9, 10, 10, 10, 10]);
    const evaluation = {
      scores: { source: 'chat' as const, risk: 3, authorization: 8 },
    };
    expect(evaluateReview(evaluation)).toMatchObject({
      risk: 3,
      authorization: 8,
      requiredAuthorization: 8,
      verdict: 'review-allow',
    });
    expect(evaluateReview(evaluation, policy)).toMatchObject({
      risk: 3,
      authorization: 8,
      requiredAuthorization: 9,
      verdict: 'review-escalate',
    });
    expect(
      scoreReview(
        score(3),
        score(2),
        {
          source: 'chat',
          audit: {
            risk: { native: null, published: null, point: 3, score: 3 },
            authorization: {
              native: null,
              published: null,
              point: 2,
              score: 2,
            },
          },
        },
        policy,
      ),
    ).toMatchObject({ requiredAuthorization: 9, verdict: 'review-escalate' });
  });

  it.each([
    [],
    [2, 2],
    [2, 2, 8, 8, 9, 9, 10, 10, 10],
    [2, 2, 8, 8, 9, 9, 10, 10, 10, 11],
    [2, 2, 8, 8, 9, 9, 10, 10, 10, 9],
    [1, 2, 8, 8, 9, 9, 10, 10, 10, 10],
    [2, 2, 8.5, 9, 9, 9, 10, 10, 10, 10],
  ])('rejects invalid requirements %j', (...values) => {
    expect(() => matrixPolicy(values)).toThrow('matrix requires ten');
  });

  it('owns immutable values and preserves both monotonic directions and A1/A10', () => {
    const input = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10];
    const policy = matrixPolicy(input);
    input[0] = 10;
    expect(policy.requiredAuthorization[0]).toBe(2);
    expect(Object.isFrozen(policy.requiredAuthorization)).toBe(true);
    const rank = { 'review-deny': 2, 'review-escalate': 1, 'review-allow': 0 };
    for (let risk = 1; risk <= 10; risk += 1) {
      expect(verdictFor(score(risk), score(1), policy)).toBe('review-deny');
      expect(verdictFor(score(risk), score(10), policy)).toBe('review-allow');
    }
    for (let risk = 1; risk <= 9; risk += 1) {
      for (let authorization = 1; authorization <= 10; authorization += 1) {
        expect(
          rank[verdictFor(score(risk + 1), score(authorization), policy)],
        ).toBeGreaterThanOrEqual(
          rank[verdictFor(score(risk), score(authorization), policy)],
        );
      }
    }
    for (let risk = 1; risk <= 10; risk += 1) {
      for (let authorization = 1; authorization <= 9; authorization += 1) {
        expect(
          rank[verdictFor(score(risk), score(authorization + 1), policy)],
        ).toBeLessThanOrEqual(
          rank[verdictFor(score(risk), score(authorization), policy)],
        );
      }
    }
  });
});
