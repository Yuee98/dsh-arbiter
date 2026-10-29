/**
 * The summary a dataset produces.
 *
 * The counts are what a reader uses to decide whether a headline number means
 * anything, so the tests pin the distinctions that keep it honest: a stale label is
 * excluded rather than averaged in, an unanswered field is an absence rather than a
 * disagreement, and a model that disagrees never changes the reference.
 */

import { describe, expect, it } from 'vitest';

import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import {
  datasetDigest,
  summarizeDataset,
} from '../../evals/src/annotation/summary.js';
import type { RawDataset } from '../../evals/src/data/read.js';
import {
  approvedTarget,
  caseReviews,
  input,
  manifest,
  modelIdentity,
  opinion,
  reviewCase,
  reviewLabel,
} from './fixtures/documents.js';

const checkers = await compileCheckers();
/** The versions the repository implements, as the CLI supplies them. */
const CURRENT = { contract: 'review-contract-v1', rubric: 'review-rubric-v1' };
const hash = inputHashOf(input());

/** One in-memory dataset, already parsed; the inspection is what is under test. */
function rawDataset(overrides: Partial<RawDataset> = {}): RawDataset {
  return {
    manifest: { path: 'manifest.json', document: manifest(['case-a']) },
    cases: [{ path: 'cases/case-a.json', document: reviewCase() }],
    labels: [{ path: 'labels/case-a.json', document: reviewLabel(hash) }],
    reviews: [{ path: 'reviews/case-a.json', document: caseReviews(hash) }],
    problems: [],
    ...overrides,
  };
}

describe('dataset summary', () => {
  it('counts cases, families, labels and opinions', () => {
    const summary = summarizeDataset(
      inspectDataset(rawDataset(), checkers, CURRENT),
    );
    expect(summary.totals).toEqual({
      cases: 1,
      families: 1,
      labels: 1,
      reviews: 1,
    });
    expect(summary.gold).toBe(1);
    expect(summary.excluded).toBe(0);
  });

  it('counts a stale label as excluded, with its reason', () => {
    const summary = summarizeDataset(
      inspectDataset(
        rawDataset({
          cases: [
            {
              path: 'cases/case-a.json',
              document: reviewCase({ input: input({ hint: 'changed' }) }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(summary.gold).toBe(0);
    expect(summary.excluded).toBe(1);
    expect(summary.exclusions['input-changed']).toBe(1);
  });

  it('counts every reason a label fails, not only the first', () => {
    const summary = summarizeDataset(
      inspectDataset(
        rawDataset({
          labels: [
            {
              path: 'labels/case-a.json',
              document: reviewLabel(hash, {
                target: approvedTarget({ status: 'disputed' }),
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(summary.exclusions['not-approved']).toBe(1);
    expect(summary.disputed).toBe(1);
  });

  it('counts a pending label separately from one under dispute', () => {
    const summary = summarizeDataset(
      inspectDataset(
        rawDataset({
          labels: [
            {
              path: 'labels/case-a.json',
              document: reviewLabel(hash, {
                target: {
                  status: 'pending',
                  allowed: { risk: [], authorization: [] },
                  behaviourReference: null,
                  rationale: '',
                  decidedBy: '',
                  decidedAt: null,
                },
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(summary.pending).toBe(1);
    expect(summary.disputed).toBe(0);
    expect(summary.excluded).toBe(1);
  });

  it('counts a model that agrees with the reference', () => {
    const summary = summarizeDataset(
      inspectDataset(rawDataset(), checkers, CURRENT),
    );
    expect(summary.agreement).toEqual([
      { provider: 'test', id: 'reviewer', compared: 1, agreed: 1 },
    ]);
    expect(summary.disagreements).toEqual([]);
  });

  it('reports a disagreement without touching the reference', () => {
    const label = reviewLabel(hash);
    const inspection = inspectDataset(
      rawDataset({
        labels: [{ path: 'labels/case-a.json', document: label }],
        reviews: [
          {
            path: 'reviews/case-a.json',
            document: caseReviews(hash, {
              reviews: [opinion({ risk: 3, authorization: 8 })],
            }),
          },
        ],
      }),
      checkers,
      CURRENT,
    );
    const summary = summarizeDataset(inspection);
    expect(summary.agreement).toEqual([
      { provider: 'test', id: 'reviewer', compared: 1, agreed: 0 },
    ]);
    expect(summary.disagreements).toEqual([
      {
        caseId: 'case-a',
        reviewId: 'review-1',
        model: 'test/reviewer',
        risk: 3,
        authorization: 8,
        observed: 'allow',
        reference: 'escalate',
      },
    ]);
    expect(inspection.labels.gold[0]?.label).toEqual(label);
  });

  it('treats an unanswered field as an absence rather than a disagreement', () => {
    const summary = summarizeDataset(
      inspectDataset(
        rawDataset({
          reviews: [
            {
              path: 'reviews/case-a.json',
              document: caseReviews(hash, {
                reviews: [opinion({ risk: null, authorization: null })],
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(summary.agreement).toEqual([
      { provider: 'test', id: 'reviewer', compared: 0, agreed: 0 },
    ]);
    expect(summary.disagreements).toEqual([]);
  });

  it('counts a model with an unknown version under its provider and id', () => {
    const summary = summarizeDataset(
      inspectDataset(
        rawDataset({
          reviews: [
            {
              path: 'reviews/case-a.json',
              document: caseReviews(hash, {
                reviews: [
                  opinion({
                    model: modelIdentity({
                      version: null,
                      versionSource: 'unknown',
                    }),
                  }),
                ],
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(summary.totals.reviews).toBe(1);
    expect(summary.agreement[0]?.id).toBe('reviewer');
  });

  it('ignores opinions for cases that are not gold', () => {
    const summary = summarizeDataset(
      inspectDataset(
        rawDataset({
          labels: [],
          reviews: [
            {
              path: 'reviews/case-a.json',
              document: caseReviews(hash, {
                reviews: [opinion({ risk: 3, authorization: 8 })],
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(summary.agreement).toEqual([]);
    expect(summary.disagreements).toEqual([]);
  });

  it('is stable across two runs over the same data', () => {
    const one = summarizeDataset(
      inspectDataset(rawDataset(), checkers, CURRENT),
    );
    const other = summarizeDataset(
      inspectDataset(rawDataset(), checkers, CURRENT),
    );
    expect(one).toEqual(other);
  });

  it('changes its digest when a decision changes', () => {
    const before = datasetDigest(
      inspectDataset(rawDataset(), checkers, CURRENT),
    );
    const after = datasetDigest(
      inspectDataset(
        rawDataset({
          labels: [
            {
              path: 'labels/case-a.json',
              document: reviewLabel(hash, {
                target: approvedTarget({ rationale: 'a different reason' }),
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(after).not.toBe(before);
    expect(after).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('keeps the digest unchanged when only file order changes', () => {
    const one = datasetDigest(inspectDataset(rawDataset(), checkers, CURRENT));
    const two = datasetDigest(
      inspectDataset(
        rawDataset({
          reviews: [
            {
              path: 'reviews/case-a.json',
              document: caseReviews(hash, {
                reviews: [opinion()],
              }),
            },
          ],
        }),
        checkers,
        CURRENT,
      ),
    );
    expect(two).toBe(one);
  });
});
