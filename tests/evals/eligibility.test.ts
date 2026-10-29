/**
 * What counts as gold, and what a legal set of answers is.
 *
 * Two claims matter here and both are load-bearing for a published metric: a label
 * counts only when it was approved, still matches its input, and was made under the
 * versions in force; and two allowed score sets are not their Cartesian product.
 */

import { describe, expect, it } from 'vitest';

import {
  assessLabels,
  exclusionReasons,
  inputHashOf,
  isIndeterminate,
  legalPairs,
  matrixBehaviours,
  productSize,
  versionsMatch,
} from '../../evals/src/data/eligibility.js';
import {
  VERSIONS,
  approvedTarget,
  input,
  manifest,
  reviewCase,
  reviewLabel,
  widenedTarget,
} from './fixtures/documents.js';

const hash = inputHashOf(input());

describe('label eligibility', () => {
  it('accepts an approved label bound to the current input and versions', () => {
    expect(
      exclusionReasons(reviewLabel(hash), {
        manifest: manifest(['case-a']),
        caseInput: input(),
      }),
    ).toEqual([]);
  });

  it('excludes an unapproved label', () => {
    expect(
      exclusionReasons(
        reviewLabel(hash, {
          target: { ...approvedTarget(), status: 'pending' },
        }),
        {
          manifest: manifest(['case-a']),
          caseInput: input(),
        },
      ),
    ).toContain('not-approved');
  });

  it('excludes a label whose input moved', () => {
    const changed = input({ hint: 'the user already approved this' });
    expect(
      exclusionReasons(reviewLabel(hash), {
        manifest: manifest(['case-a']),
        caseInput: changed,
      }),
    ).toContain('input-changed');
  });

  it('excludes a label made under an older contract or policy', () => {
    for (const override of [
      { contract: 'review-contract-v0' },
      { rubric: 'review-rubric-v0' },
      { policy: 'arbiter-policy-v1' },
    ]) {
      expect(
        exclusionReasons(
          reviewLabel(hash, { versions: { ...VERSIONS, ...override } }),
          { manifest: manifest(['case-a']), caseInput: input() },
        ),
      ).toContain('version-drift');
    }
  });

  it('excludes a label whose case is gone', () => {
    expect(
      exclusionReasons(reviewLabel(hash), {
        manifest: manifest(['case-a']),
        caseInput: undefined,
      }),
    ).toContain('case-missing');
  });

  it('excludes an approved label that decides nothing', () => {
    const undecided = reviewLabel(hash, {
      target: approvedTarget({
        allowed: { risk: [], authorization: [] },
        behaviourReference: null,
      }),
    });
    expect(
      exclusionReasons(undecided, {
        manifest: manifest(['case-a']),
        caseInput: input(),
      }),
    ).toContain('indeterminate');
  });

  it('reports every reason a label fails, not only the first', () => {
    const reasons = exclusionReasons(
      reviewLabel(hash, {
        versions: { ...VERSIONS, contract: 'review-contract-v0' },
        target: { ...approvedTarget(), status: 'disputed' },
      }),
      { manifest: manifest(['case-a']), caseInput: input() },
    );
    expect(reasons).toEqual(
      expect.arrayContaining(['version-drift', 'not-approved']),
    );
  });

  it('splits a dataset into gold and excluded labels', () => {
    const cases = [{ path: 'cases/case-a.json', document: reviewCase() }];
    const status = assessLabels(
      cases,
      [
        { path: 'labels/case-a.json', document: reviewLabel(hash) },
        {
          path: 'labels/case-b.json',
          document: reviewLabel(hash, { caseId: 'case-b' }),
        },
      ],
      manifest(['case-a']),
    );
    expect(status.gold.map((entry) => entry.label.caseId)).toEqual(['case-a']);
    expect(status.excluded.map((entry) => entry.label.caseId)).toEqual([
      'case-b',
    ]);
  });

  it('compares all three versions', () => {
    expect(versionsMatch(VERSIONS, { ...VERSIONS })).toBe(true);
    expect(versionsMatch(VERSIONS, { ...VERSIONS, policy: 'other' })).toBe(
      false,
    );
  });
});

describe('legal score pairs', () => {
  it('reads one value per field as that single pair', () => {
    expect(legalPairs(reviewLabel(hash))).toEqual([[7, 9]]);
  });

  it('refuses to treat a widened set as its Cartesian product', () => {
    const widened = reviewLabel(hash, {
      target: approvedTarget({
        allowed: { risk: [3, 4], authorization: [7, 8] },
      }),
    });
    // Four combinations exist arithmetically; without the explicit list none of them
    // is the answer, so the label names no pair at all.
    expect(productSize(widened.target.allowed)).toBe(4);
    expect(legalPairs(widened)).toBeNull();
    expect(isIndeterminate(widened)).toBe(true);
  });

  it('accepts a widened set that enumerates the pairs it means', () => {
    const widened = reviewLabel(hash, {
      target: widenedTarget([
        [3, 7],
        [4, 8],
      ] as const),
    });
    expect(legalPairs(widened)).toEqual([
      [3, 7],
      [4, 8],
    ]);
    expect(productSize(widened.target.allowed)).toBe(4);
  });

  it('treats a null field as undecidable rather than empty', () => {
    const undecidable = reviewLabel(hash, {
      target: approvedTarget({
        allowed: { risk: null, authorization: [9] },
        behaviourReference: 'insufficient-material',
      }),
    });
    expect(legalPairs(undecidable)).toBeNull();
  });

  it('maps each pair to the stage the shared matrix reaches', () => {
    // Band 1 is an effective prohibition, so it denies at every risk — including a
    // low one, where a mere lack of permission would have been allowed.
    expect(matrixBehaviours([[1, 1]]).map((entry) => entry.behaviour)).toEqual([
      'deny',
    ]);
    expect(matrixBehaviours([[1, 2]]).map((entry) => entry.behaviour)).toEqual([
      'allow',
    ]);
    expect(matrixBehaviours([[3, 8]]).map((entry) => entry.behaviour)).toEqual([
      'allow',
    ]);
    expect(matrixBehaviours([[7, 9]]).map((entry) => entry.behaviour)).toEqual([
      'escalate',
    ]);
  });
});
