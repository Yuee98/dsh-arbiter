import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  applyProbeOverrides,
  compareStrategies,
  decideReview,
  reclassifySignals,
  strategyFor,
} from '../src/policy.js';
import type { ReviewSignals } from '../src/types.js';

const normal = DEFAULT_CONFIG.policy.normal;
const progress = DEFAULT_CONFIG.policy.progress;

/**
 * A neutral signal set: the lowest risk, and A2 — "no applicable permission" —
 * rather than A1. Since the shared rubric makes band 1 an *effective prohibition*
 * that always denies, a default of 1 would put that refusal in the path of every
 * case below and stop them testing what they name.
 */
const signals = (overrides: Partial<ReviewSignals> = {}): ReviewSignals => ({
  riskDist: null,
  riskPoint: 1,
  riskScore: null,
  riskClass: 'low',
  authDist: null,
  authPoint: 2,
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
      signals({ riskPoint: 2, authPoint: 2 }),
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
      authPoint: 2,
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
      for (const auth of [1, 5, 8, 10]) {
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
      authDist: { '8': 0.85, '9': 0.1, '2': 0.05 },
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
      authPoint: 2,
      authClass: 'none',
    });
    const decisionNone = signals({
      riskPoint: null,
      riskDist: { '1': 0.1, '5': 0.8, '7': 0.1 },
      riskClass: 'medium',
      authPoint: null,
      authDist: { '2': 0.9, '8': 0.1 },
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

describe('calibrated rule rows', () => {
  test('R8 stays reachable for an unresolved uncertainty instead of being reported as R5', () => {
    // An identified risk and an unresolved uncertainty are different findings:
    // telling a human that a risk was measured when the model was not confident
    // enough to measure one misstates the evidence they are asked to accept.
    const uncertain = signals({
      riskPoint: null,
      riskDist: {
        '1': 0.15,
        '3': 0.15,
        '5': 0.2,
        '6': 0.2,
        '7': 0.2,
        '8': 0.1,
      },
      riskClass: 'medium',
      authPoint: null,
      authDist: { '8': 0.8, '9': 0.2 },
      authClass: 'explicit',
      source: 'decision',
    });
    const decision = decideReview(uncertain, 'normal', normal);
    expect(decision.verdict).toBe('review-escalate');
    expect(decision.decisionRules).toEqual(['R8']);
    expect(decision.reason).toContain('did not clear the risk gate');

    // The identified-risk path keeps reporting R5.
    const identified = signals({
      riskPoint: 7,
      riskClass: 'medium',
      authPoint: 9,
      authClass: 'explicit',
    });
    const overCeiling = decideReview(identified, 'normal', normal);
    expect(overCeiling.verdict).toBe('review-escalate');
    expect(overCeiling.decisionRules).toEqual(['R5']);
  });

  test('the risk-category boundary is a constant, not a tuning knob', () => {
    // `low` is 0-3 for both protocols (docs/reviewer.md#design-5-5). A decision
    // distribution sitting entirely inside the medium band must not be
    // reclassified as low by any policy field: that would drop its authorization
    // requirement while the equivalent chat call still escalated.
    const raw = signals({
      riskPoint: null,
      riskDist: { '4': 0.2, '5': 0.6, '6': 0.2 },
      riskClass: 'medium',
      authPoint: null,
      authDist: { '2': 0.7, '3': 0.2, '6': 0.1 },
      authClass: 'none',
      source: 'decision',
    });
    // Widen every delegable ceiling and keep the authorization evidence absent:
    // the engine must still refuse to delegate. Deriving the class with the
    // production helper is the point — a hand-set `low` would bypass the very
    // classification this test protects.
    const widened = {
      ...normal,
      chatMediumRiskMax: 10,
      mediumRiskCeiling: 10,
      tauLow: 0.1,
    };
    const mediumBand = reclassifySignals(raw, widened);
    expect(mediumBand.riskClass).toBe('medium');
    const decision = decideReview(mediumBand, 'normal', widened);
    expect(decision.verdict).toBe('review-escalate');
    expect(decision.decisionRules).toEqual(['R3']);
  });

  test('an implied goal never satisfies a medium-risk delegation in any mode', () => {
    // The unified authorization standard is the same in all three modes; only
    // the risk ceiling and bulk egress move for progress.
    const implied = signals({
      riskPoint: 5,
      riskClass: 'medium',
      authPoint: 6,
      authClass: 'implied',
    });
    for (const [strategy, thresholds] of [
      ['normal', normal],
      ['normal', normal],
      ['progress', progress],
    ] as const) {
      const decision = decideReview(implied, strategy, thresholds);
      expect(decision.verdict).toBe('review-escalate');
      expect(decision.decisionRules).toContain('R3');
    }
  });

  test('calibrated gate boundaries are observable at the shipped values', () => {
    // Each pair sits immediately either side of a calibrated probability gate.
    // They are what makes the chosen value falsifiable: a gate moved past either
    // sample flips one of these verdicts.
    const gatePair = (riskProbabilities: Record<string, number>) =>
      signals({
        riskPoint: null,
        riskDist: riskProbabilities,
        riskClass: 'medium',
        authPoint: null,
        authDist: { '8': 0.8, '9': 0.2 },
        authClass: 'explicit',
        source: 'decision',
      });
    expect(
      decideReview(gatePair({ '5': 0.4, '6': 0.4, '7': 0.2 }), 'normal', normal)
        .verdict,
    ).toBe('review-allow');
    const blocked = decideReview(
      gatePair({ '5': 0.35, '6': 0.35, '7': 0.3 }),
      'normal',
      normal,
    );
    expect(blocked.verdict).toBe('review-escalate');
    expect(blocked.decisionRules).toEqual(['R8']);
  });
});
