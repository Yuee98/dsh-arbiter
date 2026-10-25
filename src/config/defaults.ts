import type { ArbiterConfig, PolicyThresholds } from '../types.js';

export const POLICY_VERSION = 'arbiter-policy-v1';

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
