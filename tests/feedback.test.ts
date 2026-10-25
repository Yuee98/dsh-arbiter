import { describe, expect, test } from 'vitest';

import { decisionFeedback } from '../src/host/feedback.js';
import type { ReviewSnapshot } from '../src/types.js';

function snapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    version: 1,
    createdAt: 1,
    configRevision: 'test',
    callId: 'c1',
    sessionId: 's1',
    sessionKind: 'main',
    tool: 'bash',
    cwd: '/workspace',
    action: { name: 'bash', arguments: { command: 'echo hi' } },
    facts: null,
    projectRules: null,
    customRules: '',
    materials: [],
    evidence: [],
    evidenceTruncated: false,
    parentAuthorizationPresent: null,
    context: [],
    checkpoints: [],
    contextTruncated: false,
    priorVerdicts: [],
    historyTruncated: false,
    historyStatus: {
      coverage: 'complete',
      windowTruncated: false,
      reason: null,
      sources: {
        memory: { read: 3, unavailable: null },
        session: { read: 0, unavailable: null },
        audit: { read: 0, unavailable: null },
      },
      reset: false,
    },
    missing: [],
    budget: {
      maxInputTokens: 10_000,
      estimatedInputTokens: 100,
      truncatedSegments: [],
    },
    ...overrides,
  };
}

describe('decision feedback', () => {
  test('a rule deny names the rule and does not borrow review language', () => {
    const text = decisionFeedback({
      result: 'deny',
      ruleId: 'no-rm',
      decisionRules: [],
      reviewReason: null,
      snapshot: null,
    });
    expect(text).toContain('Not executed [deny-rule]:');
    expect(text).toContain('rule "no-rm"');
    // It states a rule, not a review or a human answer; the recovery hint may
    // still tell the agent to ask the user.
    expect(text).not.toContain('review rule');
    expect(text).not.toContain('the user rejected');
    expect(text).not.toContain('human-deny');
  });

  test('a review deny reports the review rules and the model reason', () => {
    const text = decisionFeedback({
      result: 'review-deny',
      ruleId: null,
      decisionRules: ['R1'],
      reviewReason: 'sensitive material would leave the machine',
      snapshot: snapshot(),
    });
    expect(text).toContain('review rule R1');
    expect(text).toContain('sensitive material would leave the machine');
  });

  test('a fallback is never reported as a human rejection', () => {
    const text = decisionFeedback({
      result: 'fallback-deny',
      ruleId: null,
      decisionRules: [],
      reviewReason: null,
      snapshot: null,
    });
    expect(text).toContain('fallback-deny');
    expect(text).toContain('no human decision was available');
    expect(text).not.toContain('user rejected');
    expect(text).not.toContain('human-deny');
  });

  test('an abort says no answer arrived, not that the user refused', () => {
    const text = decisionFeedback({
      result: 'human-abort',
      ruleId: null,
      decisionRules: [],
      reviewReason: null,
      snapshot: null,
    });
    expect(text).toContain('without a grant or a denial');
    expect(text).not.toContain('rejected');
  });

  test('truncation and missing sources are combined with the decision', () => {
    const text = decisionFeedback({
      result: 'review-deny',
      ruleId: null,
      decisionRules: ['R3'],
      reviewReason: 'no sufficient authorization was found',
      snapshot: snapshot({
        action: {
          name: 'bash',
          arguments: { command: 'echo hi' },
          programText: 'const x = 1;',
          truncated: {
            originalChars: 5_000,
            retainedChars: 900,
            field: 'programText',
            omittedFrom: 900,
            omittedTo: 5_000,
          },
        },
        missing: ['PROJECT_RULES is unavailable'],
        budget: {
          maxInputTokens: 10_000,
          estimatedInputTokens: 9_900,
          truncatedSegments: ['EVIDENCE'],
        },
      }),
    });
    expect(text).toContain('review rule R3');
    expect(text).toContain('truncated by the input budget');
    expect(text).toContain('authorization evidence was trimmed');
    expect(text).toContain('PROJECT_RULES is unavailable');
    // It offers recovery without claiming truncation caused the verdict.
    expect(text).toContain('Shortening the program');
    expect(text).not.toContain('because it was truncated');
  });

  test('a decision without context facts omits those sections entirely', () => {
    const text = decisionFeedback({
      result: 'human-deny',
      ruleId: null,
      decisionRules: [],
      reviewReason: null,
      snapshot: snapshot(),
    });
    expect(text).toContain('the user rejected this call');
    expect(text).not.toContain('Input completeness');
    expect(text).not.toContain('Unavailable context');
  });
});
