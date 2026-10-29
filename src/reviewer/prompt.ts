/**
 * One request, rendered for both protocols.
 *
 * The pairs differ only in packaging, never in semantics: the material and the
 * contract are composed once, then handed to whichever envelope the configured
 * backend reads. That is what makes "the same public output for the same public
 * input" a property of the code rather than a hope about two prompts.
 *
 *   chat      → system = contract + the public 1..10 scale + the answer shape
 *               user   = the labelled material
 *   decision  → state  = contract + the native answer note + the same material
 *               questions = the two 0..9 score questions
 *
 * Neither package restates the other's numbering: a chat answer is public, so its
 * scale is printed 1..10; a decision criterion list *is* its scale, so it stays
 * native 0..9 and the state only says which end is which. Sending both
 * numberings to one backend would ask the model which one it means.
 */

import { estimateTokenCount } from 'tokenx';
import type { ReviewSnapshot } from '../types.js';
import { CHAT_ANSWER_FORMAT, REVIEW_CONTRACT, scaleText } from './contract.js';
import { renderMaterial } from './material.js';
import { buildQuestions } from './questions.js';

/** The chat request: a system contract and one labelled user message. */
export interface ChatRequest {
  readonly system: string;
  readonly user: string;
  readonly estimatedInputTokens: number;
}

/** The decision request: one state string and the questions object. */
export interface DecisionRequest {
  readonly state: string;
  readonly questions: unknown;
  readonly estimatedInputTokens: number;
}

/**
 * The decision contract: the shared text plus what a native endpoint needs said.
 *
 * A native endpoint has no system role and no free-text output, so the contract
 * travels in `state`; it also has no prose to explain the numbering, so one
 * sentence names which criterion is which end of the scale.
 */
function decisionContract(): string {
  return [
    REVIEW_CONTRACT,
    '## Answer',
    'Answer both score questions with a probability distribution over their ten criteria. The criteria are numbered from 0: criterion 0 is the lowest band and criterion 9 is the highest, so the list is the scale.',
  ].join('\n\n');
}

/** The chat system message: the contract plus the public scale and answer shape. */
export function renderChatSystem(): string {
  return [REVIEW_CONTRACT, scaleText(), CHAT_ANSWER_FORMAT].join('\n\n');
}

/** The chat user message: the whole submission, in the one shared order. */
export function renderChatUser(snapshot: ReviewSnapshot): string {
  return renderMaterial(snapshot);
}

/** The decision state: the same submission, prefixed by the same contract. */
export function renderDecisionState(material: string): string {
  return [decisionContract(), material].join('\n\n');
}

/** Render the chat request for one snapshot. */
export function renderChatRequest(snapshot: ReviewSnapshot): ChatRequest {
  const system = renderChatSystem();
  const user = renderChatUser(snapshot);
  return {
    system,
    user,
    estimatedInputTokens: estimateTokenCount(system) + estimateTokenCount(user),
  };
}

/**
 * Render the decision request for one material payload.
 *
 * `material` is passed in rather than derived from a snapshot so the input-budget
 * step can render a trimmed candidate without rebuilding a snapshot first; the
 * result is identical to {@link renderChatUser} for the same snapshot.
 */
export function renderDecisionRequest(material: string): DecisionRequest {
  const state = renderDecisionState(material);
  const questions = buildQuestions();
  return {
    state,
    questions,
    estimatedInputTokens:
      estimateTokenCount(state) + estimateTokenCount(JSON.stringify(questions)),
  };
}
