import type { ArbiterConfig } from '../types.js';

/**
 * The review policy version this build implements.
 *
 * It names the *runtime* policy epoch, which changed when the execution chain moved
 * onto the shared contract: the thresholds, the three strategies and the probe
 * override are gone, and the matrix in `review-contract` decides. The semantic
 * version of the score bands themselves is `REVIEW_CONTRACT_VERSION`; the two are
 * separate so a stored record can say both which bands it was graded on and which
 * engine applied them.
 */
export const POLICY_VERSION = 'arbiter-policy-v3';

/**
 * The confirmed configuration.
 *
 * `modes` is the only policy knob left, and it names one observable difference:
 * whether an escalation may open a real human approval. Both values apply the same
 * matrix, so `no-ask` is not a stricter policy.
 *
 * `no-ask` is the default for a subagent because a child session has no approval
 * channel of its own; asking for one would settle as a fallback denial anyway, and
 * stating that up front makes the record say why instead of implying a question
 * nobody could answer.
 */
export const DEFAULT_CONFIG: ArbiterConfig = {
  enabled: true,
  // The confirmed first-release boundary. It is applied only when a session is
  // enabled, so installation still takes over nothing.
  boundary: 'guarded',
  modes: { main: 'ask', subagent: 'no-ask' },
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
