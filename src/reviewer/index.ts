/**
 * The new reviewer: one callable service, one semantic source.
 *
 * Production will reach this module through the gate once RQ-04 switches the entry
 * point; the evals tooling calls it directly with a case-built snapshot. Both see
 * one renderer, one parser, one normalization and one outcome type, so their
 * results are comparable rather than merely similar.
 *
 * Not exported from here: the legacy adapters (`chat.ts`, `decision.ts`) and their
 * signal shape. Those still serve the current gate and are replaced wholesale by
 * RQ-04; keeping them out of this surface is what makes "the new path has no probes
 * and no threshold fallback" checkable from the imports alone.
 */

export type {
  ChatBackend,
  DecisionBackend,
  ReviewRequest,
  ReviewResult,
} from './service.js';
export { review, reviewWith } from './service.js';

export type { ReviewAttempt, ReviewerBackend } from './attempt.js';
export { attemptIdOf, storedAttemptOf } from './attempt.js';

export type { ChatTransportContext, ChatTransportResult } from './chat.js';
export { runChatTransport } from './chat.js';
export type {
  DecisionTransportContext,
  DecisionTransportResult,
} from './decision.js';
export { runDecisionTransport } from './decision.js';

export type { ChatRequest, DecisionRequest } from './prompt.js';
export {
  renderChatRequest,
  renderChatSystem,
  renderChatUser,
  renderDecisionRequest,
  renderDecisionState,
  renderVariantChatRequest,
  renderVariantChatSystem,
  renderVariantDecisionRequest,
  renderVariantDecisionState,
  renderVariantQuestions,
} from './prompt.js';
export type { VariantDecisionRequest, VariantQuestions } from './prompt.js';
export {
  buildQuestions,
  SCORE_CRITERIA_MAX,
  SCORE_FIELDS,
} from './questions.js';
export type { ScoreField } from './questions.js';
export {
  CHAT_ANSWER_FORMAT,
  CHAT_PROTOCOL,
  DECISION_PROTOCOL,
  REVIEW_CONTRACT,
  REVIEW_PROMPT_VERSION,
  scaleText,
} from './contract.js';
export { renderMaterial, submissionParts } from './material.js';
export {
  renderCompactMaterial,
  renderVariantMaterial,
} from './variant-material.js';

export type { ParsedAnswer } from './signals.js';
export { readChatAnswer, readDecisionAnswer } from './signals.js';

export type { ReviewPackage } from './package.js';
export {
  PRODUCTION_PACKAGE,
  probeOfAttempt,
  probesOf,
  variantPackage,
} from './package.js';
export type {
  ProbeOption,
  ProbeReading,
  ProbeUnreadableReason,
} from './probe.js';
export {
  CHAT_PROBE_ANSWER_FORMAT,
  PROBE_MEMBER,
  PROBE_OPTIONS,
  probeDecisionQuestion,
  readProbeAnswer,
  RECOVERABILITY_PROBE_QUESTION,
  REVIEW_PROBE_VERSION,
} from './probe.js';
export type {
  HistoryVariant,
  PromptVariant,
  ReviewVariant,
  ScaleVariant,
  StructureVariant,
  VariantAxes,
} from './variant.js';
export {
  defineVariant,
  isProductionVariant,
  parseVariantId,
  productionDiff,
  PRODUCTION_VARIANT,
  REVIEW_VARIANT_VERSION,
  variantDiff,
  variantIdFor,
} from './variant.js';
export {
  compressQuestions,
  renderLabelScaleText,
  SCALE_GUARD,
} from './scale.js';

export {
  decisionAnswers,
  providerExplanation,
  reportedUsage,
  requestShapeOf,
} from './envelope.js';
export type { RequestShape } from './envelope.js';

export {
  aggregateUsage,
  normalizeUsage,
  USAGE_FIELDS,
  USAGE_MAPPING_VERSION,
} from './usage.js';
export type {
  TokenCounts,
  UsageAggregate,
  UsageAttempt,
  UsageField,
  UsageFieldSource,
  UsageFieldTotal,
  UsageInclusion,
  UsageInclusions,
  UsageNormalized,
  UsageSource,
} from './usage.js';

export type {
  ChatRoute,
  LlmLike,
  LlmModelLike,
  LlmProviderLike,
  SessionLike,
  StreamOptionsLike,
} from './llm.js';
export { chatRoute, collectChatText } from './llm.js';

export { offlineChatBackend, offlineDecisionBackend } from './offline.js';
export type {
  OfflineChatOptions,
  OfflineChatScript,
  OfflineDecisionOptions,
  OfflineDecisionScript,
  OfflineResponse,
} from './offline.js';
