/**
 * Reviewer modules.
 *
 * Two surfaces live here for one delivery window, and the boundary between them
 * is deliberate:
 *
 *   - `./reviewer/index.js` is the new reviewer service: one renderer, one parser,
 *     one normalization, one outcome type, no effect probes and no threshold
 *     fallback. Production reaches it through the gate once RQ-04 switches the
 *     entry point; the evals tooling calls it directly today.
 *   - the `legacy/` adapters still serve the current gate and the audit's attempt
 *     shape. They are replaced wholesale by RQ-04 and are not re-exported from the
 *     new service surface.
 *
 * Both are exported from this module because the gate imports them from here; the
 * split is a file boundary rather than a naming convention, so a caller reading
 * the new service's exports cannot pick up a probe by accident.
 */

export * from './reviewer/index.js';

export {
  buildQuestions,
  renderDecisionState,
  renderRequest,
  renderSystem,
  renderUser,
} from './reviewer/legacy/prompt.js';
export {
  extractJsonObject,
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
} from './reviewer/legacy/signals.js';
export { runChatReviewer } from './reviewer/legacy/chat.js';
export { runDecisionReviewer } from './reviewer/legacy/decision.js';
export { PROBE_SNAPSHOT, runReviewerProbe } from './reviewer/diagnostic.js';
