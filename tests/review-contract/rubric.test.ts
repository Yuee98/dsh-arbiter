/**
 * The rubric is the single semantic source for both scales, and the criteria list
 * has a hard length limit: the `score` question schema accepts at most ten entries,
 * so an eleventh band cannot be sent to a real backend at all.
 *
 * These tests pin the properties a later reader most needs: exactly ten bands per
 * scale, the two numberings naming the same band, and the chat anchor text and the
 * decision criteria describing one band list rather than two copies.
 */

import { describe, expect, test } from 'vitest';

import { native, score } from '../helpers/score.js';
import {
  anchorTextOf,
  AUTHORIZATION_BANDS,
  authorizationCriteria,
  criteriaOf,
  isNativeLevel,
  isPublicScore,
  nativeLevelOf,
  publicScoreOf,
  requiredAuthorizationFor,
  RISK_BANDS,
  riskCriteria,
  REVIEW_CONTRACT_VERSION,
} from '../../src/review-contract/index.js';

describe('review contract rubric', () => {
  test('names a versioned public contract', () => {
    expect(REVIEW_CONTRACT_VERSION).toBe('review-contract-v1');
  });

  test.each([
    ['risk', RISK_BANDS],
    ['authorization', AUTHORIZATION_BANDS],
  ])('%s has exactly ten bands in order', (_name, bands) => {
    expect(bands).toHaveLength(10);
    expect(bands.map((band) => band.score)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    // A duplicate or empty criterion would make two bands indistinguishable and
    // give a model no way to pick between them.
    const criteria = bands.map((band) => band.criterion);
    expect(new Set(criteria).size).toBe(10);
    for (const criterion of criteria)
      expect(criterion.length).toBeGreaterThan(0);
  });

  test('the decision criteria stop at ten entries', () => {
    // This is the 422 regression: `score` accepts `minItems: 2, maxItems: 10`, so
    // eleven criteria are rejected by both real backends before any review runs.
    expect(riskCriteria()).toHaveLength(10);
    expect(authorizationCriteria()).toHaveLength(10);
    for (const criteria of [riskCriteria(), authorizationCriteria()]) {
      expect(criteria.length).toBeLessThanOrEqual(10);
      expect(criteria.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('native criteria are numbered from zero and describe the public bands', () => {
    const criteria = riskCriteria();
    // Native numbering is the protocol's own: level 0 is the first band, so the
    // ten bands occupy 0..9 and public band 1 is native level 0.
    expect(criteria[0]?.startsWith('0 ')).toBe(true);
    expect(criteria[9]?.startsWith('9 ')).toBe(true);
    for (const [index, line] of criteria.entries()) {
      expect(line.startsWith(`${String(index)} `)).toBe(true);
      expect(line.slice(2)).toBe(RISK_BANDS[index]?.criterion);
    }
  });

  test('chat anchors and decision criteria come from one band list', () => {
    // The two protocols print the same ten bands under different numbering. If
    // either list were maintained separately, the same score would name different
    // facts depending on the backend.
    for (const [bands, criteria] of [
      [RISK_BANDS, riskCriteria()],
      [AUTHORIZATION_BANDS, authorizationCriteria()],
    ] as const) {
      const anchors = anchorTextOf(bands).split('\n');
      expect(anchors).toHaveLength(10);
      for (const [index, anchor] of anchors.entries()) {
        expect(anchor).toBe(
          `${String(index + 1)} ${bands[index]?.criterion ?? ''}`,
        );
        // The native line carries the same criterion text, one level lower.
        expect(criteria[index]?.slice(2)).toBe(bands[index]?.criterion);
      }
    }
  });

  test('the two scales describe prohibition and absence differently', () => {
    // A1 is an effective prohibition and A2 is "no applicable permission". The
    // matrix allows the second at low risk and refuses the first, so the wording
    // has to keep them apart rather than treating 1 as the weakest evidence.
    const a1 = AUTHORIZATION_BANDS[0]?.criterion ?? '';
    const a2 = AUTHORIZATION_BANDS[1]?.criterion ?? '';
    expect(a1).toContain('prohibition');
    expect(a2).not.toContain('prohibition');
    expect(a2).toContain('no applicable permission');
    expect(AUTHORIZATION_BANDS[9]?.criterion).toContain('fully covered');
  });

  test.each([
    [1, 0],
    [2, 1],
    [9, 8],
    [10, 9],
  ])('public %i is native %i and back', (publicValue, level) => {
    expect(nativeLevelOf(score(publicValue))).toBe(level);
    expect(publicScoreOf(native(level))).toBe(publicValue);
  });

  test('the predicates are the range check, so nothing can be clamped', () => {
    // The conversion functions accept only legal values; the "refused, not
    // clamped" property therefore lives in the predicates, and a clamp cannot
    // invent a plausible band for a number that is not a score.
    for (let publicValue = 1; publicValue <= 10; publicValue += 1) {
      expect(publicScoreOf(nativeLevelOf(score(publicValue)))).toBe(
        publicValue,
      );
    }
    expect(isPublicScore(0)).toBe(false);
    expect(isPublicScore(11)).toBe(false);
    expect(isNativeLevel(10)).toBe(false);
    expect(isNativeLevel(-1)).toBe(false);
  });

  test('score and level predicates accept only the ten values', () => {
    for (let score = 0; score <= 11; score += 1) {
      expect(isPublicScore(score)).toBe(score >= 1 && score <= 10);
    }
    for (let level = -1; level <= 10; level += 1) {
      expect(isNativeLevel(level)).toBe(level >= 0 && level <= 9);
    }
    expect(isPublicScore(1.5)).toBe(false);
    expect(isNativeLevel('3')).toBe(false);
  });

  test('criteriaOf keeps the numbering in step with any band list', () => {
    const criteria = criteriaOf(AUTHORIZATION_BANDS);
    expect(criteria).toHaveLength(AUTHORIZATION_BANDS.length);
    expect(criteria[0]).toBe(`0 ${AUTHORIZATION_BANDS[0]?.criterion ?? ''}`);
  });
});

describe('shared matrix thresholds', () => {
  test.each([
    [1, 2],
    [2, 2],
    [3, 8],
    [4, 8],
    [5, 9],
    [6, 9],
    [7, 10],
    [8, 10],
    [9, 10],
    [10, 10],
  ])('risk %i requires authorization %i', (risk, required) => {
    expect(requiredAuthorizationFor(score(risk))).toBe(required);
  });
});
