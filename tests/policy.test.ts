import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  applyProbeOverrides,
  compareStrategies,
  decideReview,
  strategyFor,
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

describe('mode to strategy mapping', () => {
  test('normal and strict share one strategy, progress does not', () => {
    expect(strategyFor('normal')).toBe('normal');
    expect(strategyFor('strict')).toBe('normal');
    expect(strategyFor('progress')).toBe('progress');
  });

  test('the same signals decide identically under normal and strict', () => {
    // Representative signals for every rule row, including the boundary values
    // where a stricter mode would have differed in the retired design.
    const grid: readonly ReviewSignals[] = [
      signals(),
      signals({
        riskPoint: 4,
        riskClass: 'medium',
        authPoint: 8,
        authClass: 'explicit',
      }),
      signals({
        riskPoint: 6,
        riskClass: 'medium',
        authPoint: 8,
        authClass: 'explicit',
      }),
      signals({
        riskPoint: 6,
        riskClass: 'medium',
        authPoint: 2,
        authClass: 'none',
      }),
      signals({ riskPoint: 9, riskClass: 'high' }),
      signals({ secrets: true, egress: true, riskPoint: 5 }),
      signals({ destructive: true, bulk: true, riskPoint: 8 }),
      signals({
        bulk: true,
        egress: true,
        riskPoint: 7,
        authPoint: 9,
        authClass: 'explicit',
      }),
      signals({
        riskPoint: null,
        riskDist: { '1': 0.2, '5': 0.5, '9': 0.3 },
        riskClass: 'medium',
      }),
    ];
    for (const input of grid) {
      expect(decideReview(input, strategyFor('strict'), normal)).toEqual(
        decideReview(input, strategyFor('normal'), normal),
      );
    }
  });

  test('automatic allow range is normal = strict and a subset of progress', () => {
    const allows: Record<string, Set<string>> = {
      normal: new Set(),
      strict: new Set(),
      progress: new Set(),
    };
    for (const risk of [1, 4, 6, 8, 9]) {
      for (const auth of [0, 5, 8, 10]) {
        for (const bulk of [false, true]) {
          for (const egress of [false, true]) {
            const input = signals({
              riskPoint: risk,
              riskClass: risk <= 3 ? 'low' : risk <= 8 ? 'medium' : 'high',
              authPoint: auth,
              authClass:
                auth >= 8 ? 'explicit' : auth >= 5 ? 'implied' : 'none',
              bulk,
              egress,
            });
            const key = `${String(risk)}/${String(auth)}/${String(bulk)}/${String(egress)}`;
            for (const [mode, thresholds] of [
              ['normal', normal],
              ['strict', normal],
              ['progress', progress],
            ] as const) {
              if (
                decideReview(input, strategyFor(mode), thresholds).verdict ===
                'review-allow'
              )
                allows[mode]?.add(key);
            }
          }
        }
      }
    }
    expect([...(allows['strict'] ?? [])].sort()).toEqual(
      [...(allows['normal'] ?? [])].sort(),
    );
    for (const key of allows['normal'] ?? []) {
      expect(allows['progress']?.has(key)).toBe(true);
    }
  });

  test('chat and decision share one authorization standard', () => {
    // Same authorization level *and* the same risk facts, in each protocol's
    // own shape: the authorization standard must agree on both.
    const chatExplicit = signals({
      riskPoint: 3,
      riskClass: 'low',
      authPoint: 8,
      authClass: 'explicit',
    });
    const decisionExplicit = signals({
      riskPoint: null,
      riskDist: { '1': 0.8, '3': 0.15, '9': 0.05 },
      riskClass: 'low',
      authPoint: null,
      authDist: { '8': 0.85, '9': 0.1, '1': 0.05 },
      authClass: 'explicit',
      source: 'decision',
    });
    expect(decideReview(chatExplicit, 'normal', normal).verdict).toBe(
      decideReview(decisionExplicit, 'normal', normal).verdict,
    );
    // A medium-risk call without authorization: both protocols escalate, and
    // through the same rule, because the authorization standard is shared.
    const chatNone = signals({
      riskPoint: 5,
      riskClass: 'medium',
      authPoint: 1,
      authClass: 'none',
    });
    const decisionNone = signals({
      riskPoint: null,
      riskDist: { '1': 0.1, '5': 0.8, '7': 0.1 },
      riskClass: 'medium',
      authPoint: null,
      authDist: { '1': 0.9, '8': 0.1 },
      authClass: 'none',
      source: 'decision',
    });
    const chat = decideReview(chatNone, 'normal', normal);
    const decided = decideReview(decisionNone, 'normal', normal);
    expect(chat.verdict).toBe('review-escalate');
    expect(decided.verdict).toBe(chat.verdict);
    expect(chat.decisionRules).toEqual(decided.decisionRules);
  });
});
