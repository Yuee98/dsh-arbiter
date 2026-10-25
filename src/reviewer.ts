/**
 * Reviewer backends, output contracts and the unified signal representation.
 *
 * The model classifies; this module validates and converts. A malformed or
 * contradictory answer never becomes an allow: it is repaired at most the
 * configured number of times and then reported as a review failure, which the
 * approval layer turns into an error escalation.
 */

export {
  buildQuestions,
  renderSystem,
  renderUser,
  renderRequest,
  renderDecisionState,
} from './reviewer/prompt.js';
export {
  extractJsonObject,
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
} from './reviewer/signals.js';
export { runChatReviewer } from './reviewer/chat.js';
export type {
  LlmLike,
  LlmModelLike,
  LlmProviderLike,
} from './reviewer/chat.js';
export { runDecisionReviewer } from './reviewer/decision.js';
export { PROBE_SNAPSHOT, runReviewerProbe } from './reviewer/diagnostic.js';
