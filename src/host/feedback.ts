/**
 * Agent-facing feedback for an Arbiter decision.
 *
 * One composition point for the three things a blocked agent needs: which rule
 * or review result decided, what the input was missing or truncated, and the
 * model's own reason. The text never claims that truncation caused the verdict,
 * and it never presents a fallback or an abort as a human rejection — the agent
 * must be able to tell "please ask the user" from "the user said no".
 *
 * The recovery hint is advice, not a promise: a shorter program or a narrower
 * scope may let a complete review happen, but nothing here overrides a rule.
 */

import type { CallResult, ReviewSnapshot } from '../types.js';
import { truncationFeedback } from '../snapshot.js';

/**
 * The bracketed tag each outcome keeps in agent-facing text.
 *
 * These tags predate this module and are asserted by existing host tests: a
 * rule denial reads `[deny-rule]`, not `[deny]`. Keeping them stable is part of
 * not changing a visible contract while only the wording around them improves.
 */
const RESULT_TAGS: Readonly<Record<string, string>> = {
  deny: 'deny-rule',
  'review-deny': 'review-deny',
  'human-deny': 'human-deny',
  'human-abort': 'human-abort',
  'fallback-deny': 'fallback-deny',
};

/** The words each decision stage used, so the agent can tell them apart. */
const RESULT_LABELS: Readonly<Record<string, string>> = {
  deny: 'a deny rule matched this call',
  'review-deny': 'the review denied this call',
  'human-deny': 'the user rejected this call',
  'human-abort': 'the approval ended without a grant or a denial',
  'fallback-deny': 'no human decision was available for this call',
};

/** What the agent can do next, keyed by the outcome that blocked it. */
const RECOVERY_HINTS: Readonly<Record<string, string>> = {
  deny: 'The rule is deterministic; changing the command does not bypass it. Ask the user about the intended action or use an allowed alternative.',
  'review-deny':
    'Try a narrower action, or ask the user for the authorization or information the review could not confirm.',
  'human-deny':
    'Do not retry the same call. Ask the user what they want instead.',
  'human-abort':
    'The user did not decide. Ask again or request a narrower action; a new call is reviewed from the start.',
  'fallback-deny':
    'This mode does not open approvals, so the call was not executed. Ask the user in conversation, or propose an action that does not need human approval.',
};

export interface FeedbackInput {
  readonly result: CallResult;
  /** The rule that matched, when a rule decided the call. */
  readonly ruleId: string | null;
  /** The review rules that decided the call, when the review did. */
  readonly decisionRules: readonly string[];
  /** The human-readable review reason, when one exists. */
  readonly reviewReason: string | null;
  /** The snapshot this call was reviewed against, if it was. */
  readonly snapshot: ReviewSnapshot | null;
}

function rulePart(input: FeedbackInput): string | null {
  if (input.ruleId !== null) return `rule "${input.ruleId}"`;
  if (input.decisionRules.length === 0) return null;
  return `review rule${input.decisionRules.length > 1 ? 's' : ''} ${input.decisionRules.join(', ')}`;
}

/**
 * The missing/truncated facts that apply to this call.
 *
 * Truncation comes from the shared snapshot helper so the wording stays in one
 * place; missing sources are the snapshot's own list, which the context layer
 * already classified.
 */
function contextParts(snapshot: ReviewSnapshot | null): readonly string[] {
  if (snapshot === null) return [];
  const parts: string[] = [];
  const truncation = truncationFeedback(snapshot);
  if (truncation !== null) parts.push(truncation);
  if (snapshot.missing.length > 0) {
    parts.push(`Unavailable context: ${snapshot.missing.join('; ')}.`);
  }
  return parts;
}

/**
 * Build the text one blocked call reports to the agent.
 *
 * Shape: `Not executed [<result>]: <what decided>. <what was missing>. <what to
 * do next>`. Each section is omitted when it has nothing true to say, so a rule
 * deny does not borrow review language and a fallback never reads as a refusal.
 */
export function decisionFeedback(input: FeedbackInput): string {
  const label = RESULT_LABELS[input.result] ?? 'this call was not executed';
  const sections: string[] = [];
  const rule = rulePart(input);
  sections.push(
    rule === null
      ? `${label}.`
      : `${label} (${rule})${input.reviewReason === null ? '.' : `: ${input.reviewReason}.`}`,
  );
  if (rule === null && input.reviewReason !== null)
    sections.push(`${input.reviewReason}.`);
  sections.push(...contextParts(input.snapshot));
  const hint = RECOVERY_HINTS[input.result];
  if (hint !== undefined) sections.push(hint);
  const tag = RESULT_TAGS[input.result] ?? input.result;
  return `Not executed [${tag}]: ${sections.join(' ')}`;
}
