/**
 * The experimental material layouts.
 *
 * Production renders one labelled-block payload. An experiment compares three
 * layouts, and each is a *rendering of the same parts* (`submissionParts` in
 * `material.ts`) — never a second reading of the snapshot. That is what keeps the
 * comparison about presentation: a compact layout cannot drop a fact, only prose.
 *
 * The two steps are the design's own order and each is defined on top of the
 * previous one, so a comparison can attribute a change to exactly one step:
 *
 *   compact            one JSON envelope, self-describing members, and none of the
 *                      block sentences that restate the contract or explain a label.
 *                      The values are the production ones, unchanged.
 *   compact-no-audit   also drops the four members that describe the submission
 *                      rather than judge it: the configuration revision, the turn
 *                      number, the guidance char counts and the input budget. They
 *                      stay in the run record, so the ablation loses no evidence — it
 *                      only asks whether the answer changes when the reviewer stops
 *                      seeing them.
 *
 * Two rules are structural:
 *
 *   - the history ablation keeps its member present and says it was withheld. A
 *     removed member would make "withheld" indistinguishable from "the turn was
 *     empty", and those are different facts about a submission.
 *   - the pending action and the completeness status survive every layout, so a
 *     reader of a truncated payload still sees what would run.
 */

import type { ReviewSnapshot } from '../types.js';

import {
  HISTORY_WITHHELD_NOTE,
  json,
  NONE_TEXT,
  NO_FACTS_TEXT,
  submissionParts,
} from './material.js';
import type { SubmissionParts } from './material.js';
import type { ReviewVariant } from './variant.js';

/** Whether a layout keeps the audit-only metadata. */
function keepsAudit(structure: ReviewVariant['structure']): boolean {
  return structure !== 'compact-no-audit';
}

/** The policy member: the two guidance sources, unchanged. */
function compactPolicy(parts: SubmissionParts, audit: boolean): object {
  return {
    project_rules: parts.policy.projectRules ?? NONE_TEXT,
    custom_rules:
      parts.policy.customRules.length > 0
        ? parts.policy.customRules
        : NONE_TEXT,
    ...(audit
      ? {
          materials: parts.policy.materials,
          project_rules_enabled: parts.policy.projectRulesEnabled,
        }
      : {}),
  };
}

/** The environment member: where the call would run. */
function compactEnvironment(parts: SubmissionParts, audit: boolean): object {
  return {
    cwd: parts.environment.cwd,
    tool: parts.environment.tool,
    session_kind: parts.environment.session_kind,
    ...(audit
      ? {
          turn: parts.environment.turn,
          config_revision: parts.environment.config_revision,
        }
      : {}),
  };
}

/** The history member, withheld or not. */
function compactHistory(
  parts: SubmissionParts,
  history: ReviewVariant['history'],
): object {
  if (history === 'none') {
    return { withheld: true, note: HISTORY_WITHHELD_NOTE };
  }
  return {
    tool_calls: parts.history.tool_calls,
    checkpoints: parts.history.checkpoints,
    truncated: parts.history.truncated,
  };
}

/** The action member, with its derived facts and the hint. */
function compactAction(parts: SubmissionParts): object {
  return {
    pending_action: parts.action.action,
    action_facts:
      parts.action.facts === null ? NO_FACTS_TEXT : parts.action.facts,
    ...(parts.action.hint === undefined
      ? {}
      : { review_hint: parts.action.hint }),
  };
}

/** The completeness member, with the budget removed when audit is not kept. */
function compactCompleteness(parts: SubmissionParts, audit: boolean): object {
  return {
    status: parts.completeness.status,
    blocking_gaps: parts.completeness.blocking_gaps,
    missing_input: parts.completeness.missing_input,
    ...(audit
      ? {
          note: parts.completeness.note,
          budget: parts.completeness.budget,
          action_truncated: parts.completeness.action_truncated,
        }
      : {}),
  };
}

/**
 * The compact layout.
 *
 * The key order is the design's block order, so a reader who knows the production
 * payload can locate the same material: policy, environment, authorization, history,
 * prior verdicts, the action, then completeness.
 */
export function renderCompactMaterial(
  snapshot: ReviewSnapshot,
  variant: ReviewVariant,
): string {
  const parts = submissionParts(snapshot);
  const audit = keepsAudit(variant.structure);
  return json({
    policy: compactPolicy(parts, audit),
    environment: compactEnvironment(parts, audit),
    human_authorization: parts.authorization,
    turn_tool_history: compactHistory(parts, variant.history),
    prior_verdicts: parts.prior,
    ...compactAction(parts),
    material_completeness: compactCompleteness(parts, audit),
  });
}

/**
 * The material one variant submits.
 *
 * `full` delegates to production's own renderer rather than restating it, so the
 * baseline of every comparison is literally the bytes production sends.
 */
export function renderVariantMaterial(
  snapshot: ReviewSnapshot,
  variant: ReviewVariant,
  productionMaterial: (snapshot: ReviewSnapshot) => string,
): string {
  if (variant.structure === 'full') return productionMaterial(snapshot);
  return renderCompactMaterial(snapshot, variant);
}
