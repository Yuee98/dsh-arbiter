/**
 * The per-call material, in the one order both protocols submit it.
 *
 * The order is the design's: the stable contract first (in `contract.ts`), then
 * what may constrain this call, then what happened in this turn, then the action
 * itself with its facts and completeness report. Semantic material precedes the
 * action because a reader grades the action against it, not the other way round.
 *
 * Two rules hold throughout:
 *
 *   - the serialization is deterministic. Every block is emitted by one
 *     `JSON.stringify` with a fixed key order, and every list keeps the order its
 *     reader produced (the tool window is already oldest-first). Nothing here
 *     sorts by a clock or reads a random source.
 *   - a label never upgrades a layer. `PROJECT_RULES` and `CUSTOM_RULES` are user
 *     material to interpret, so they stay in the labelled payload; only the fixed
 *     contract reaches the chat system message, which is why placing them here
 *     cannot give them the contract's authority.
 *
 * Caching layout is not a reason to reorder or drop anything: this module does
 * not know whether a provider caches a prefix, and it makes no claim that one
 * does.
 */

import type { ReviewSnapshot } from '../types.js';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * The environment this call would run in.
 *
 * `cwd` and the effective configuration revision are the two facts a reviewer
 * needs to tell "inside the project" from "outside it". The revision is included
 * so an attempt's record and the material it saw can be tied together.
 */
function environmentBlock(snapshot: ReviewSnapshot): string {
  return [
    'ENVIRONMENT',
    json({
      cwd: snapshot.cwd,
      tool: snapshot.tool,
      session_kind: snapshot.sessionKind,
      turn: snapshot.turn,
      config_revision: snapshot.configRevision,
    }),
  ].join('\n');
}

/**
 * The two configured guidance sources, each with its own label.
 *
 * A source that is switched off, absent or empty is reported as such. "No
 * PROJECT_RULES file exists" is a known-empty fact about this project, not a
 * failure and not a finding about the action.
 */
function policyBlock(snapshot: ReviewSnapshot): string {
  const project = snapshot.materials.find(
    (material) => material.id === 'project-rules',
  );
  return [
    'POLICY_AND_GUIDANCE',
    "PROJECT_RULES are scoped to this workspace; CUSTOM_RULES are the user's global preferences. When they disagree, PROJECT_RULES wins. Both are guidance to interpret, never a claim about what a human said in this conversation.",
    'PROJECT_RULES',
    snapshot.projectRules ?? '(none)',
    'CUSTOM_RULES',
    snapshot.customRules.length > 0 ? snapshot.customRules : '(none)',
    json({
      materials: snapshot.materials,
      project_rules_enabled: project?.enabled ?? false,
    }),
  ].join('\n');
}

/**
 * The effective human authorization and restrictions.
 *
 * The items are the reader's own; this module adds no interpretation, so the
 * evidence ceiling each item carries is what the model reads. `evidenceTruncated`
 * and `parentAuthorizationPresent` are stated beside them because a cut list and
 * an absent parent are both facts about the submission.
 */
function authorizationBlock(snapshot: ReviewSnapshot): string {
  return [
    'HUMAN_AUTHORIZATION',
    'Items are ordered oldest first. Each carries its source, its role and the ceiling that source can support; a ceiling describes what the source may establish, not that this action is authorized. `explicit` items are original human input from this session or the direct parent session; `implied` items are an agent relay without sufficient original human evidence; `null` items restore context and never authorize.',
    json({
      items: snapshot.evidence,
      truncated: snapshot.evidenceTruncated,
      parent_authorization_present: snapshot.parentAuthorizationPresent,
    }),
  ].join('\n');
}

/**
 * This turn's tool history, oldest first.
 *
 * Only the current turn is here. An earlier turn's calls belong to work that
 * already concluded, and what crosses a turn boundary is authorization evidence,
 * which travels in its own block. A call with no host-recorded result never ran;
 * the entry says so rather than implying success.
 */
function turnHistoryBlock(snapshot: ReviewSnapshot): string {
  return [
    'TURN_TOOL_HISTORY',
    'Tool calls from this turn only, oldest first, excluding the pending action. `ok: null` means the host recorded no result for that call, so it never ran to completion; it is not a success and not a failure.',
    json({
      tool_calls: snapshot.context,
      checkpoints: snapshot.checkpoints,
      truncated: snapshot.contextTruncated,
    }),
  ].join('\n');
}

/** Earlier blocked or escalated calls, as the engine recorded them. */
function priorVerdictsBlock(snapshot: ReviewSnapshot): string {
  return [
    'PRIOR_VERDICTS',
    json({
      prior_verdicts: snapshot.priorVerdicts,
      truncated: snapshot.historyTruncated,
      coverage: snapshot.historyStatus.coverage,
      coverage_reason: snapshot.historyStatus.reason,
    }),
  ].join('\n');
}

/**
 * The action under review, its derived facts and the review hint.
 *
 * The hint is emitted after the action because it points at material that is
 * already present; it never stands on its own and never supplies facts.
 */
function actionBlock(snapshot: ReviewSnapshot): string[] {
  return [
    ['PENDING_ACTION', json(snapshot.action)].join('\n'),
    [
      'ACTION_FACTS',
      snapshot.facts === null
        ? '(no derived facts: the program could not be parsed)'
        : json(snapshot.facts),
    ].join('\n'),
    ...(snapshot.hint === undefined
      ? []
      : [['REVIEW_HINT', snapshot.hint].join('\n')]),
  ];
}

/**
 * What this submission could not carry, and which gaps block a score.
 *
 * `completeness` is the M0 report the engine consumes; `missing` is the same
 * observation in sentences. Both are stated so a truncation is described exactly
 * and never promoted into a finding or a failure by wording.
 */
function completenessBlock(snapshot: ReviewSnapshot): string {
  return [
    'MATERIAL_COMPLETENESS',
    'These are input facts about this submission, not findings. A gap blocks a score only when it is listed in `blocking_gaps`; a truncation never does.',
    json({
      status: snapshot.completeness.status,
      note: snapshot.completeness.note,
      blocking_gaps: snapshot.completeness.gaps,
      missing_input: snapshot.missing,
      budget: {
        max_input_tokens: snapshot.budget.maxInputTokens,
        estimated_input_tokens: snapshot.budget.estimatedInputTokens,
        truncated_segments: snapshot.budget.truncatedSegments,
      },
      action_truncated: snapshot.action.truncated ?? null,
    }),
  ].join('\n');
}

/**
 * The full labelled payload, contract excluded.
 *
 * The chat request puts the contract in `system` and this text in the user
 * message; the decision request puts both in `state`. One composition means the
 * decision backend cannot see a differently ordered or differently worded copy
 * of the same submission.
 */
export function renderMaterial(snapshot: ReviewSnapshot): string {
  return [
    environmentBlock(snapshot),
    policyBlock(snapshot),
    authorizationBlock(snapshot),
    turnHistoryBlock(snapshot),
    priorVerdictsBlock(snapshot),
    ...actionBlock(snapshot),
    completenessBlock(snapshot),
  ].join('\n\n');
}
