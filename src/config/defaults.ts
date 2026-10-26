import type { ArbiterConfig, PolicyThresholds } from '../types.js';

/**
 * The calibrated first-release policy version.
 *
 * v1 shipped the prototype's numbers, reported every risk-gate failure as R5
 * (which made R8 unreachable), and derived decision risk classes from a
 * hardcoded low band. #22 fixed those and replaced the numbers with values whose
 * admissible intervals are derived from a labelled sample set in
 * `validation/arbiter-integration/2026-10-26-policy-calibration/`.
 *
 * R5 still means "above the selected risk ceiling": the operation classes the
 * rule matrix names (production change, security-control change, irreversible
 * delete) have no observable signal yet, so they are recorded as a limitation
 * rather than claimed as implemented. Old audit rows keep their own recorded
 * thresholds, so they stay explainable under the version they were decided with.
 */
export const POLICY_VERSION = 'arbiter-policy-v2';

/**
 * The regular strategy, shared by `normal` and `strict`.
 *
 * Read the calibration record before changing any of these numbers: the values
 * are the grid midpoints of the intervals the labelled samples permit, and
 * `tests/policy-calibration.test.ts` fails when a default leaves its interval.
 * That test proves the values agree with the documented matrix. A small real-model
 * run (see the same record's `model-run/`) showed the chat backend produces
 * conforming signals, but it measured no false-allow or false-block rate, so
 * these remain reviewed initial values rather than a calibration result.
 */
export const DEFAULT_NORMAL: PolicyThresholds = {
  tauAuth: 0.8,
  tauRisk: 0.75,
  tauCritical: 0.25,
  tauLow: 0.7,
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
      // Thinking and the answer share this output budget. At 400 the model spent
      // every token reasoning and returned no JSON at all, so every review
      // failed closed (validation/arbiter-integration model-run, #22).
      maxTokens: 10_000,
      // First requests measured 1.9-5.2s on the real backend; a long reasoning
      // pass plus one format-repair retry needs more than the old 8s.
      timeoutMs: 20_000,
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
