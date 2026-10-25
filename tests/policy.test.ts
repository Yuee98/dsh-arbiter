import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  applyProbeOverrides,
  compareStrategies,
  decideReview,
} from '../src/policy.js';
import type { ReviewSignals } from '../src/types.js';

const normal = DEFAULT_CONFIG.policy.normal;
const progress = DEFAULT_CONFIG.policy.progress;

const signals = (overrides: Partial<ReviewSignals> = {}): ReviewSignals => ({
  riskDist: null,
  riskPoint: 1,
  riskScore: null,
  riskClass: 'low',
  authDist: null,
  authPoint: 1,
  authClass: 'none',
  secrets: false,
  destructive: false,
  egress: false,
  bulk: false,
  source: 'chat',
  repairs: 0,
  ...overrides,
});

describe('review policy', () => {
  test('ordinary low-risk work is allowed without explicit authorization', () => {
    expect(decideReview(signals(), 'normal', normal).verdict).toBe(
      'review-allow',
    );
  });

  test('normal and strict share the regular strategy', () => {
    const medium = signals({
      riskPoint: 6,
      riskClass: 'medium',
      authPoint: 8,
      authClass: 'explicit',
    });
    expect(decideReview(medium, 'normal', normal).verdict).toBe('review-allow');
    expect(decideReview(medium, 'normal', normal)).toEqual(
      decideReview(medium, 'normal', normal),
    );
  });

  test('explicitFromRisk can require authorization even for low point values', () => {
    const configured = { ...normal, explicitFromRisk: 2 };
    const decision = decideReview(
      signals({ riskPoint: 2, authPoint: 1 }),
      'normal',
      configured,
    );
    expect(decision.verdict).toBe('review-escalate');
    expect(decision.decisionRules).toContain('R3');
  });

  test('medium risk without explicit authorization escalates', () => {
    const decision = decideReview(
      signals({
        riskPoint: 6,
        riskClass: 'medium',
        authPoint: 2,
        authClass: 'none',
      }),
      'normal',
      normal,
    );
    expect(decision.verdict).toBe('review-escalate');
    expect(decision.decisionRules).toContain('R3');
  });

  test('high risk is denied regardless of authorization', () => {
    const decision = decideReview(
      signals({
        riskPoint: 9,
        riskClass: 'high',
        authPoint: 10,
        authClass: 'explicit',
        destructive: true,
      }),
      'normal',
      normal,
    );
    expect(decision.verdict).toBe('review-deny');
    expect(decision.decisionRules).toContain('R2');
  });

  test('secrets plus egress is a fixed deny', () => {
    const decision = decideReview(
      signals({
        riskPoint: 8,
        riskClass: 'medium',
        secrets: true,
        egress: true,
      }),
      'progress',
      progress,
    );
    expect(decision.verdict).toBe('review-deny');
    expect(decision.decisionRules).toContain('R1');
  });

  test('bulk irreversible destruction escalates in every mode', () => {
    expect(
      decideReview(
        signals({
          riskPoint: 8,
          riskClass: 'medium',
          destructive: true,
          bulk: true,
        }),
        'normal',
        normal,
      ).verdict,
    ).toBe('review-escalate');
    expect(
      decideReview(
        signals({
          riskPoint: 8,
          riskClass: 'medium',
          destructive: true,
          bulk: true,
        }),
        'progress',
        progress,
      ).verdict,
    ).toBe('review-escalate');
  });

  test('progress bulk egress still requires explicit authorization', () => {
    const unauthorized = signals({
      riskPoint: 3,
      authPoint: 0,
      authClass: 'none',
      bulk: true,
      egress: true,
    });
    expect(decideReview(unauthorized, 'progress', progress).verdict).toBe(
      'review-escalate',
    );
  });

  test('progress widens the medium-risk and bulk-egress rows', () => {
    const bulkEgress = signals({
      riskPoint: 7,
      riskClass: 'medium',
      authPoint: 9,
      authClass: 'explicit',
      egress: true,
      bulk: true,
    });
    expect(decideReview(bulkEgress, 'normal', normal).verdict).toBe(
      'review-escalate',
    );
    expect(decideReview(bulkEgress, 'progress', progress).verdict).toBe(
      'review-allow',
    );
    expect(compareStrategies(bulkEgress, normal, progress).promoted).toBe(true);
  });

  test('decision distributions use cumulative probability gates', () => {
    const decision = decideReview(
      signals({
        riskPoint: null,
        riskDist: { '1': 0.8, '2': 0.1, '5': 0.1 },
        riskClass: 'low',
        authPoint: null,
        authDist: { '8': 0.7, '9': 0.2, '3': 0.1 },
        authClass: 'explicit',
        source: 'decision',
      }),
      'normal',
      normal,
    );
    expect(decision.verdict).toBe('review-allow');
  });
});

describe('probe overrides', () => {
  test('assist leaves model probes untouched', () => {
    const base = signals();
    expect(applyProbeOverrides(base, null, 'assist')).toEqual(base);
  });

  test('override can only set probes to true', () => {
    const facts = {
      version: 1 as const,
      parse: { status: 'ok' as const, statements: 1 },
      observed: {
        writes: ['/tmp/a'],
        networkCommands: ['curl'],
        credentialPaths: ['/home/.ssh/id_rsa'],
        pipelineExec: [['curl', 'sh']],
        substitutions: 0,
        subshells: 0,
      },
      opaque: false,
      opaqueReason: null,
      unresolvedExpansions: [],
      expansionRisk: null,
      completeness: 'complete' as const,
      parentAuthorizationPresent: null,
      overlapsDeniedEffect: false,
      historyTruncated: false,
    };
    const overridden = applyProbeOverrides(signals(), facts, 'override');
    expect(overridden.egress).toBe(true);
    expect(overridden.secrets).toBe(true);
    expect(overridden.destructive).toBe(true);
    expect(overridden.bulk).toBe(false);
    const alreadyClean = applyProbeOverrides(
      { ...signals(), egress: false },
      null,
      'override',
    );
    expect(alreadyClean.egress).toBe(false);
  });
});
