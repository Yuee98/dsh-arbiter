/** Measure the actual renderer pair; selection is shared by both protocols. */
import type { ReviewSnapshot } from '../types.js';
import { PRODUCTION_PACKAGE } from '../reviewer/package.js';
import { renderDecisionRequest } from '../reviewer/prompt.js';
import type { ReviewPackage } from '../reviewer/package.js';

export type BudgetRenderers = Pick<
  ReviewPackage,
  'renderChat' | 'renderDecision'
>;

export function measureSnapshot(
  snapshot: ReviewSnapshot,
  renderers: BudgetRenderers = PRODUCTION_PACKAGE,
) {
  const chat = renderers.renderChat(snapshot);
  const decision =
    renderers === PRODUCTION_PACKAGE
      ? renderDecisionRequest(chat.user)
      : renderers.renderDecision(snapshot);
  return {
    chat,
    decision,
    tokens: Math.max(chat.estimatedInputTokens, decision.estimatedInputTokens),
  };
}

export function contribution(
  before: ReviewSnapshot,
  after: ReviewSnapshot,
  renderers: BudgetRenderers,
): number {
  const empty = measureSnapshot(before, renderers);
  const full = measureSnapshot(after, renderers);
  return Math.max(
    0,
    full.chat.estimatedInputTokens - empty.chat.estimatedInputTokens,
    full.decision.estimatedInputTokens - empty.decision.estimatedInputTokens,
  );
}
