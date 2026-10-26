import type { ArbiterConfig, PolicyThresholds } from '../types.js';

/**
 * The calibrated first-release policy version.
 *
 * v1 shipped the prototype's numbers and an R5 that could only mean "above the
 * risk ceiling". #22 replaced both: every threshold below is bracketed by a
 * labelled sample pair in
 * `validation/arbiter-integration/2026-10-26-policy-calibration/cases.json`, and
 * R5 now reports the operation classes the rule matrix names. Old audit rows keep
 * their own recorded thresholds, so they stay explainable under the version they
 * were decided with.
 */
export const POLICY_VERSION = 'arbiter-policy-v2';

/**
 * The regular strategy, shared by `normal` and `strict`.
 *
 * Read the calibration record before changing any of these numbers: the values
 * are the grid midpoints of the intervals the labelled samples permit, and
 * `tests/policy-calibration.test.ts` fails when a default leaves its interval.
 * That test proves the values agree with the documented matrix; it says nothing
 * about accuracy against a real model, which has not been measured.
 */
export const DEFAULT_NORMAL: PolicyThresholds = {
  tauAuth: 0.8,
  tauRisk: 0.75,
  tauCritical: 0.25,
  tauLow: 0.7,
  chatLowRiskMax: 3,
  chatMediumRiskMax: 6,
  mediumRiskCeiling: 6,
  explicitFromRisk: 4,
  allowBulkEgress: false,
};

/**
 * The progress strategy.
 *
 * It differs from the regular strategy on exactly the two axes the design names:
 * the medium-risk ceiling (6 → 8, i.e. force pushes and staging deploys become
 * delegable) and bulk external sending. It never widens a fixed denial, the
 * authorization standard or the critical gate.
 */
export const DEFAULT_PROGRESS: PolicyThresholds = {
  ...DEFAULT_NORMAL,
  chatMediumRiskMax: 8,
  mediumRiskCeiling: 8,
  allowBulkEgress: true,
};

export const DEFAULT_CONFIG: ArbiterConfig = {
  enabled: true,
  // The confirmed first-release boundary. It is applied only when a session is
  // enabled, so installation still takes over nothing.
  boundary: 'guarded',
  modes: { main: 'normal', subagent: 'strict' },
  rules: [],
  reviewer: {
    type: 'chat',
    chat: {
      provider: 'session',
      model: '',
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 8_000,
      maxRepairRetries: 1,
    },
    decision: {
      url: '',
      model: 'clef-flash',
      apiKeyRef: 'CLOUDFLARE_API_TOKEN',
      timeoutMs: 8_000,
      costTier: 'paid',
    },
  },
  policy: {
    version: POLICY_VERSION,
    normal: DEFAULT_NORMAL,
    progress: DEFAULT_PROGRESS,
    probeMode: 'assist',
  },
  context: {
    maxInputTokens: 10_000,
    evidenceMaxItems: 20,
    parentHumanItems: 5,
    parentEvidenceFloor: 1,
    historyMaxItems: 40,
    checkpointMaxItems: 3,
    toolCallArgumentMaxChars: 200,
    customRules: '',
    projectRules: { enabled: true, files: ['.dsh/arbiter.md', '.arbiter.md'] },
  },
  audit: {
    enabled: true,
    retentionDays: 30,
    retentionBytes: 1024 * 1024 * 1024,
    maxQueue: 500,
  },
  breaker: {
    mode: 'preset',
    preset: 'balanced',
    consecutiveDenials: 3,
    windowDenials: 6,
    windowSize: 10,
  },
  reviewBudget: null,
};
