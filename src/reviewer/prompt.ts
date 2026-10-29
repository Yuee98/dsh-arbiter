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
 *
 * Two entry points, deliberately separate:
 *
 *   - `renderChatRequest`, `renderChatSystem`, `renderChatUser`,
 *     `renderDecisionRequest`, `renderDecisionState` render the production package.
 *     They take no variant, so `review()` cannot reach a variant by accident.
 *   - `renderVariantRequest` renders one experiment package. It is told which variant
 *     to render and never becomes a default.
 */

import { estimateTokenCount } from 'tokenx';
import type { ReviewSnapshot } from '../types.js';
import { CHAT_ANSWER_FORMAT, REVIEW_CONTRACT, scaleText } from './contract.js';
import { renderMaterial } from './material.js';
import { buildQuestions } from './questions.js';
import type { ScoreQuestions } from './questions.js';
import {
  CHAT_PROBE_ANSWER_FORMAT,
  probeDecisionQuestion,
  RECOVERABILITY_PROBE_QUESTION,
} from './probe.js';
import { compressQuestions, renderLabelScaleText } from './scale.js';
import { renderVariantMaterial } from './variant-material.js';
import type { ReviewVariant } from './variant.js';

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

/**
 * The band text one variant prints.
 *
 * `complete` is production's own list, not a copy: the compressed variant is the only
 * one that renders different text, and it does so from the same shared bands.
 */
function variantScaleText(variant: ReviewVariant): string {
  return variant.scale === 'complete' ? scaleText() : renderLabelScaleText();
}

/**
 * The chat system message for one variant.
 *
 * The contract text itself never varies: only the scale's wording and whether the
 * probe question and its answer member are present. That is what lets a comparison
 * say "the probe changed the answer" instead of "the prompt changed".
 */
export function renderVariantChatSystem(variant: ReviewVariant): string {
  return [
    REVIEW_CONTRACT,
    variantScaleText(variant),
    ...(variant.prompt === 'recovery-probe'
      ? [RECOVERABILITY_PROBE_QUESTION, CHAT_PROBE_ANSWER_FORMAT]
      : [CHAT_ANSWER_FORMAT]),
  ].join('\n\n');
}

/**
 * The decision state for one material, under one variant.
 *
 * The scale never travels in `state`, for either variant: a decision criterion list
 * *is* its scale, and printing the public 1..10 list beside native 0..9 criteria would
 * ask the model which numbering it means. A compressed variant therefore carries its
 * compressed criteria in the questions and the guard in the question instructions,
 * while `state` stays exactly production's.
 */
export function renderVariantDecisionState(material: string): string {
  return renderDecisionState(material);
}

/**
 * The two score questions for one variant.
 *
 * A variant that keeps the complete scale returns production's own questions,
 * unchanged: the native criteria list is what the endpoint validates, so restating it
 * would be a second copy of the scale. A compressed variant rewrites the criteria and
 * appends the guard; the probe, when present, is a separate question so the two score
 * answers stay the question they were.
 */
export function renderVariantQuestions(
  variant: ReviewVariant,
  productionQuestions: () => ScoreQuestions = buildQuestions,
): VariantQuestions {
  const scored =
    variant.scale === 'complete'
      ? productionQuestions()
      : compressQuestions(productionQuestions());
  if (variant.prompt !== 'recovery-probe') return scored;
  return { ...scored, recoverability: probeDecisionQuestion() };
}

/**
 * The question set one variant asks.
 *
 * The two score questions, plus the probe exactly when the package asks it. Named rather
 * than left as `unknown` so a reader can tell that a variant adds a question *beside* the
 * scored ones — the shape is what makes that impossible to confuse.
 */
export type VariantQuestions = ScoreQuestions & {
  readonly recoverability?: ReturnType<typeof probeDecisionQuestion>;
};

/** A variant's decision request: production's state plus its own question set. */
export interface VariantDecisionRequest {
  readonly state: string;
  readonly questions: VariantQuestions;
  readonly estimatedInputTokens: number;
}

/**
 * Render the chat request under one variant.
 *
 * `productionMaterial` is injected rather than imported so the baseline of a
 * comparison is literally the production renderer: a full-layout variant submits the
 * production bytes, and only the axes that changed differ.
 */
export function renderVariantChatRequest(
  snapshot: ReviewSnapshot,
  variant: ReviewVariant,
  productionMaterial: (snapshot: ReviewSnapshot) => string = renderMaterial,
): ChatRequest {
  const system = renderVariantChatSystem(variant);
  const user = renderVariantMaterial(snapshot, variant, productionMaterial);
  return {
    system,
    user,
    estimatedInputTokens: estimateTokenCount(system) + estimateTokenCount(user),
  };
}

/**
 * Render the decision request under one variant.
 *
 * The state stays production's for either scale: a native criteria list *is* the
 * scale, so printing the public one beside it would ask the model which numbering it
 * means. Only the questions and the material can differ.
 */
export function renderVariantDecisionRequest(
  snapshot: ReviewSnapshot,
  variant: ReviewVariant,
  productionMaterial: (snapshot: ReviewSnapshot) => string = renderMaterial,
): VariantDecisionRequest {
  const state = renderVariantDecisionState(
    renderVariantMaterial(snapshot, variant, productionMaterial),
  );
  const questions = renderVariantQuestions(variant);
  return {
    state,
    questions,
    estimatedInputTokens:
      estimateTokenCount(state) + estimateTokenCount(JSON.stringify(questions)),
  };
}
