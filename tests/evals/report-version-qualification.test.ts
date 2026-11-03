import { describe, expect, it } from 'vitest';
import {
  commonReferenceEqual,
  evidenceVerified,
  measurementOf,
} from '../../evals/src/metrics/version-comparison-cell.js';
import {
  metricCell,
  metricReference,
  scored,
  FAILED,
} from './helpers/quality-cells.js';

describe('version comparison metric qualification', () => {
  it('compares actual adjudication contents and provenance rather than a reference ID alone', () => {
    const cell = metricCell('same');
    expect(commonReferenceEqual(cell, cell)).toBe(true);
    const changed = [
      metricReference('deny'),
      metricReference('allow', 'human-inherited'),
      { ...metricReference('allow'), scoringEligible: false },
      metricReference('allow', 'human', {
        allowed: { risk: [1], authorization: [1] },
      }),
      metricReference('allow', 'unresolved'),
      metricReference('allow', 'model-consensus'),
    ];
    for (const reference of changed)
      expect(
        commonReferenceEqual(cell, { ...cell, evaluationReference: reference }),
      ).toBe(false);
  });
  it('uses separately qualified candidate bindings without pretending their prompt hashes are equal', () => {
    const cell = metricCell('same');
    const reference = cell.evaluationReference;
    if (reference.binding === null) throw new Error('binding missing');
    const changed = {
      ...cell,
      evaluationReference: {
        ...reference,
        binding: {
          ...reference.binding,
          promptFingerprint: 'different-candidate',
        },
      },
    };
    expect(commonReferenceEqual(cell, changed)).toBe(true);
    expect(
      commonReferenceEqual(cell, {
        ...changed,
        evaluationReference: {
          ...changed.evaluationReference,
          binding: {
            ...reference.binding,
            versions: {
              ...reference.binding.versions,
              policy: 'different-policy',
            },
          },
        },
      }),
    ).toBe(false);
  });
  it('keeps technical failures outside behavior and pair measurements, and scoring eligibility independent', () => {
    const failure = metricCell('failure', { outcome: FAILED });
    expect(measurementOf(failure)).toMatchObject({
      classification: 'technical',
      pairHit: null,
      risk: null,
    });
    const noScore = metricCell('no-score', {
      outcome: scored(3, 10),
      reference: { ...metricReference('allow'), scoringEligible: false },
    });
    expect(measurementOf(noScore)).toMatchObject({
      classification: 'matched',
      behaviourEligible: true,
      scoringEligible: false,
      pairHit: null,
    });
  });
  it('requires source and actual model evidence and refuses an index/record mismatch', () => {
    const cell = metricCell('cell');
    if (cell.record === null) throw new Error('fixture record missing');
    const record = {
      ...cell.record,
      attempts: cell.record.attempts.map((attempt) => ({
        ...attempt,
        request: {
          model: cell.model?.configured,
          provider: cell.model?.provider,
        },
      })),
    };
    const verified = {
      ...cell,
      record,
      caseFacts: {
        familyId: 'family',
        split: 'dev',
        provenance: 'synthetic',
        path: 'fixture',
        challenge: null,
        challengeVerified: false,
        source: 'dataset' as const,
        conflictsWithDataset: false,
      },
    };
    expect(evidenceVerified(verified)).toBe(true);
    for (const patch of [
      { model: null },
      { record: null },
      { inputHash: null },
      { caseFacts: null },
      { caseFacts: { ...verified.caseFacts, conflictsWithDataset: true } },
      { indexStatus: 'failed' as const },
    ])
      expect(evidenceVerified({ ...verified, ...patch })).toBe(false);
  });
});
