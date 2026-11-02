import { describe, expect, it } from 'vitest';
import { qualitySection } from '../../evals/src/metrics/quality.js';
import {
  fieldErrorStats,
  pairStats,
} from '../../evals/src/metrics/diagnostics.js';
import { stabilitySection } from '../../evals/src/metrics/stability.js';
import {
  FAILED,
  M0,
  metricCell,
  metricReference,
  mixedCells,
  scored,
} from './helpers/quality-cells.js';

const settings = { mode: 'ask', channel: 'available' } as const;

describe('complete populations and conditional quality', () => {
  it('counts twelve hand-checkable cells without hiding failures, references or recordless states', () => {
    const section = qualitySection(mixedCells(), settings);
    expect(section.overall.cells).toMatchObject({
      cells: 12,
      compared: 6,
      matched: 1,
      falseAllow: 2,
      falseDeny: 1,
      unnecessaryHuman: 1,
      escalateNotDeny: 1,
      technical: 1,
      missingRecord: 1,
      notRun: 3,
      uncompared: 1,
      referenceKnown: 11,
    });
    expect(
      Object.values(section.overall.cells.byClass).reduce(
        (sum, n) => sum + n,
        0,
      ),
    ).toBe(12);
    expect(section.references.cellsBySource).toEqual({
      human: 8,
      'human-inherited': 1,
      'model-consensus': 2,
      unresolved: 1,
    });
    expect(section.overall.conditional).toMatchObject({
      falseAllow: { numerator: 2, denominator: 3 },
      falseDeny: { numerator: 1, denominator: 3 },
      falseDenyFromAllow: { numerator: 1, denominator: 2 },
      falseDenyFromEscalate: { numerator: 0, denominator: 1 },
      unnecessaryHuman: { numerator: 1, denominator: 2 },
      unnecessaryHumanOfCompared: { numerator: 1, denominator: 6 },
      escalateNotDeny: { numerator: 1, denominator: 2 },
    });
    expect(
      section.overall.conditional.confusion.map((entry) => entry.count),
    ).toEqual([0, 1, 1, 1, 0, 1, 1, 0, 0]);
    expect(section.overall.m0).toEqual({
      expected: 1,
      observed: 1,
      matched: 1,
      knownNoDispatch: 1,
      unexpectedDispatch: 0,
      unknownDispatch: 0,
    });
    expect(section.overall.failureKinds).toEqual({ 'provider-refusal': 1 });
    expect(section.overall.statuses).toEqual({
      reviewed: 9,
      'budget-exhausted': 1,
      unsupported: 1,
      'not-run': 1,
    });
    expect(section.overall.technicalAvailability).toMatchObject({
      numerator: 6,
      denominator: 10,
    });
    expect(section.references.consensus).toHaveLength(2);
    expect(section.references.consensus[0]).toMatchObject({
      n: 4,
      k: 3,
      branch: 'n-minus-one',
    });
  });
  it('keeps all allow references in the burden denominator and unknown consequences explicit', () => {
    const burden = qualitySection(mixedCells(), settings).overall.burden;
    expect(burden).toMatchObject({
      plannedAllow: 7,
      supportedAllow: 6,
      projected: { deny: 1, 'ask-human': 2 },
      preDispatchBlocked: 1,
      unsupported: 1,
      unknown: 2,
      actualContinuation: 'not-observed',
      knownBurdenLowerBound: { numerator: 4, denominator: 7 },
      supportedBurdenLowerBound: { numerator: 4, denominator: 6 },
    });
    expect(
      qualitySection(mixedCells(), { mode: 'no-ask', channel: 'unavailable' })
        .overall.burden.projected,
    ).toEqual({ deny: 1, 'fallback-deny': 2 });
    expect(qualitySection([], settings).overall.conditional.falseAllow).toEqual(
      { numerator: 0, denominator: 0, rate: null },
    );
    expect(
      qualitySection([], settings).overall.burden.knownBurdenLowerBound.rate,
    ).toBeNull();
  });
  it('reuses exact-pair, signed-field and distance calculations with multi-source references', () => {
    const section = qualitySection(mixedCells(), settings).overall;
    expect(section.pairs).toMatchObject({
      labeled: 5,
      exactPair: 0,
      pairRate: 0,
    });
    expect(section.risk).toMatchObject({
      comparable: 5,
      meanSigned: 0.8,
      meanAbsolute: 2.4,
    });
    expect(section.authorization).toMatchObject({
      comparable: 5,
      meanSigned: 1.6,
      meanAbsolute: 5.6,
    });
    const widened = metricCell('widened', {
      outcome: scored(2, 7),
      reference: metricReference('allow', 'human', {
        allowed: { risk: [2, 3], authorization: [7, 8] },
        allowedPairs: [
          [2, 8],
          [3, 7],
        ],
      }),
    });
    expect(pairStats([widened])).toMatchObject({
      labeled: 1,
      exactPair: 0,
      outside: [{ distance: 1 }],
    });
    expect(fieldErrorStats([widened], 'risk').comparable).toBe(0);
    const partial = metricCell('partial', {
      reference: metricReference('allow', 'human', {
        allowed: { risk: [3], authorization: null },
      }),
    });
    expect(fieldErrorStats([partial], 'risk').comparable).toBe(1);
    expect(fieldErrorStats([partial], 'authorization').comparable).toBe(0);
    expect(pairStats([partial]).labeled).toBe(0);
    expect(
      fieldErrorStats(
        [
          {
            ...partial,
            evaluationReference: {
              ...metricReference('allow'),
              scoringEligible: false,
            },
          },
        ],
        'risk',
      ).comparable,
    ).toBe(0);
  });
  it('does not select a successful repeat to replace the first planned failure', () => {
    const cells = [
      metricCell('same', { outcome: FAILED }),
      metricCell('same', { repeat: 2 }),
      metricCell('same', { repeat: 3 }),
    ];
    const section = qualitySection(cells, settings);
    expect(section.overall.cells.compared).toBe(2);
    expect(section.overall.conditions).toMatchObject({
      cells: 1,
      compared: 0,
      technical: 1,
    });
    expect(section.references.unitsBySource).toEqual({ human: 1 });
    expect(section.identities).toMatchObject({
      roots: 1,
      points: 1,
      views: 1,
      repeatCells: 2,
    });
    expect(stabilitySection(cells).repeatGroups[0]).toMatchObject({
      repeats: 3,
      judged: 2,
      stable: true,
    });
    expect(
      stabilitySection(cells.slice(0, 2)).repeatGroups[0]?.stable,
    ).toBeNull();
  });
  it('evaluates no-score engineering references without counting technical failures as semantic denials', () => {
    const m0 = metricReference('insufficient-material', 'human', {
      allowed: { risk: null, authorization: null },
    });
    const failure = metricReference('review-failure', 'human', {
      allowed: { risk: null, authorization: null },
    });
    const abandoned = metricCell('abandoned', {
      outcome: null,
      status: 'timeout',
      reference: m0,
    });
    if (abandoned.record === null || abandoned.record.material === null)
      throw new Error('missing timeout fixture');
    const cells = [
      {
        ...abandoned,
        record: {
          ...abandoned.record,
          material: {
            ...abandoned.record.material,
            completenessStatus: 'insufficient' as const,
          },
          attempts: [],
          abandonment: {
            reservedAttempts: 1,
            reason: 'in-flight outcome unknown',
          },
        },
      },
      metricCell('m0', {
        outcome: M0,
        reference: { ...m0, scoringEligible: false },
      }),
      metricCell('unexpected-request', { reference: m0 }),
      metricCell('missing', { missing: true, reference: m0 }),
      metricCell('failure', {
        outcome: FAILED,
        reference: { ...failure, scoringEligible: false },
      }),
    ];
    const section = qualitySection(cells, settings).overall;
    expect(section.m0).toEqual({
      expected: 4,
      observed: 1,
      matched: 1,
      knownNoDispatch: 1,
      unexpectedDispatch: 1,
      unknownDispatch: 2,
    });
    expect(section.reviewFailure).toEqual({
      expected: 1,
      observed: 1,
      matched: 1,
    });
    expect(section.cells).toMatchObject({ technical: 2, falseDeny: 0 });
    expect(section.technicalAvailability).toMatchObject({
      numerator: 1,
      denominator: 4,
    });
    expect(section.pairs.labeled).toBe(0);
    expect(
      qualitySection(
        [
          metricCell('host-label', { entryPoint: 'host-chain' }),
          metricCell('service'),
        ],
        settings,
      ).overall.burden,
    ).toMatchObject({
      evidence: 'projected-review-and-recorded-dispatch',
      actualContinuation: 'not-observed',
    });
  });
});
