/**
 * The per-call material, in the one order both protocols submit it.
 *
 * The order is the design's (`docs/milestones/review-quality-and-evals.md` 2.4):
 * the stable contract first (in `contract.ts`), then the source-labelled policy
 * and environment, then the effective human permission and restrictions, then this
 * turn's tool history, then the action itself with its facts, hint and the dynamic
 * completeness report. Semantic material precedes the action because a reader
 * grades the action against it, not the other way round.
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
 *
 * The parts are built once by {@link submissionParts} and then rendered either as the
 * production blocks ({@link renderMaterial}) or, for an experiment, as the compact
 * envelope in `variant-material.ts`. One builder means a variant cannot invent a fact
 * production does not have, and the two layouts cannot disagree about what a value is.
 */

import type { ReviewSnapshot } from '../types.js';

/** The one JSON serialization every block uses. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** The note above PROJECT_RULES and CUSTOM_RULES. */
export const POLICY_NOTE =
  "PROJECT_RULES are scoped to this workspace; CUSTOM_RULES are the user's global preferences. When they disagree, PROJECT_RULES wins. Both are guidance to interpret, never a claim about what a human said in this conversation.";

/** The note above the human authorization items. */
export const AUTHORIZATION_NOTE =
  'Items are ordered oldest first. Each carries its source, its role and the ceiling that source can support; a ceiling describes what the source may establish, not that this action is authorized. `explicit` items are original human input from this session or the direct parent session; `implied` items are an agent relay without sufficient original human evidence; `null` items restore context and never authorize.';

/** The note above this turn's tool history. */
export const HISTORY_NOTE =
  'Tool calls from this turn only, oldest first, excluding the pending action. `ok: null` means the host recorded no result for that call, so it never ran to completion; it is not a success and not a failure.';

/**
 * The note that replaces {@link HISTORY_NOTE} when an experiment withholds history.
 *
 * It states a fact about the submission rather than an empty window, so the reader
 * cannot read "nothing was submitted" as "no call happened".
 */
export const HISTORY_WITHHELD_NOTE =
  'This experiment withheld the tool history deliberately. Its absence is a fact about this submission and not evidence that no call happened; the authorization items above are unaffected and remain the only permission evidence.';

/** The note above the completeness report. */
export const COMPLETENESS_NOTE =
  'These are input facts about this submission, not findings. A gap blocks a score only when it is listed in `blocking_gaps`; a truncation never does.';

/** The text used when the program could not be parsed. */
export const NO_FACTS_TEXT =
  '(no derived facts: the program could not be parsed)';

/** The text used for an absent guidance source. */
export const NONE_TEXT = '(none)';

/** The environment this call would run in. */
export interface EnvironmentParts {
  readonly cwd: string;
  readonly tool: string;
  readonly session_kind: string;
  readonly turn: number | null;
  readonly config_revision: string;
}

/**
 * The environment block's content.
 *
 * `cwd` and the effective configuration revision are the two facts a reviewer
 * needs to tell "inside the project" from "outside it". The revision is included
 * so an attempt's record and the material it saw can be tied together.
 */
export function environmentParts(snapshot: ReviewSnapshot): EnvironmentParts {
  return {
    cwd: snapshot.cwd,
    tool: snapshot.tool,
    session_kind: snapshot.sessionKind,
    turn: snapshot.turn,
    config_revision: snapshot.configRevision,
  };
}

/** The two configured guidance sources, each with its own label. */
export interface PolicyParts {
  readonly projectRules: string | null;
  readonly customRules: string;
  readonly materials: ReviewSnapshot['materials'];
  readonly projectRulesEnabled: boolean;
}

/**
 * The policy block's content.
 *
 * A source that is switched off, absent or empty is reported as such. "No
 * PROJECT_RULES file exists" is a known-empty fact about this project, not a
 * failure and not a finding about the action.
 */
export function policyParts(snapshot: ReviewSnapshot): PolicyParts {
  const project = snapshot.materials.find(
    (material) => material.id === 'project-rules',
  );
  return {
    projectRules: snapshot.projectRules,
    customRules: snapshot.customRules,
    materials: snapshot.materials,
    projectRulesEnabled: project?.enabled ?? false,
  };
}

/** The effective human authorization and restrictions. */
export interface AuthorizationParts {
  readonly items: ReviewSnapshot['evidence'];
  readonly truncated: boolean;
  readonly parent_authorization_present: boolean | null;
}

export function authorizationParts(
  snapshot: ReviewSnapshot,
): AuthorizationParts {
  return {
    items: snapshot.evidence,
    truncated: snapshot.evidenceTruncated,
    parent_authorization_present: snapshot.parentAuthorizationPresent,
  };
}

/** This turn's tool history, oldest first. */
export interface HistoryParts {
  readonly tool_calls: ReviewSnapshot['context'];
  readonly checkpoints: ReviewSnapshot['checkpoints'];
  readonly truncated: boolean;
}

export function historyParts(snapshot: ReviewSnapshot): HistoryParts {
  return {
    tool_calls: snapshot.context,
    checkpoints: snapshot.checkpoints,
    truncated: snapshot.contextTruncated,
  };
}

/** Earlier blocked or escalated calls, as the engine recorded them. */
export interface PriorVerdictParts {
  readonly prior_verdicts: ReviewSnapshot['priorVerdicts'];
  readonly truncated: boolean;
  readonly coverage: string;
  readonly coverage_reason: string | null;
}

export function priorVerdictParts(snapshot: ReviewSnapshot): PriorVerdictParts {
  return {
    prior_verdicts: snapshot.priorVerdicts,
    truncated: snapshot.historyTruncated,
    coverage: snapshot.historyStatus.coverage,
    coverage_reason: snapshot.historyStatus.reason,
  };
}

/** The action under review, its derived facts and the review hint. */
export interface ActionParts {
  /**
   * The action exactly as the snapshot carries it.
   *
   * Kept whole rather than rebuilt field by field: the object's own key order is part
   * of the bytes production submits, and reconstructing it would change a stored
   * request's text without changing its meaning.
   */
  readonly action: ReviewSnapshot['action'];
  readonly facts: ReviewSnapshot['facts'];
  readonly hint?: string;
}

/**
 * The action block's content.
 *
 * The hint is emitted after the action because it points at material that is
 * already present; it never stands on its own and never supplies facts.
 */
export function actionParts(snapshot: ReviewSnapshot): ActionParts {
  return {
    action: snapshot.action,
    facts: snapshot.facts,
    ...(snapshot.hint === undefined ? {} : { hint: snapshot.hint }),
  };
}

/** What this submission could not carry, and which gaps block a score. */
export interface CompletenessParts {
  readonly status: ReviewSnapshot['completeness']['status'];
  readonly note: string | null;
  readonly blocking_gaps: ReviewSnapshot['completeness']['gaps'];
  readonly missing_input: readonly string[];
  readonly budget: {
    readonly max_input_tokens: number;
    readonly estimated_input_tokens: number;
    readonly truncated_segments: readonly string[];
  };
  readonly action_truncated: ReviewSnapshot['action']['truncated'] | null;
}

export function completenessParts(snapshot: ReviewSnapshot): CompletenessParts {
  return {
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
  };
}

/** Everything one submission carries, before any layout renders it. */
export interface SubmissionParts {
  readonly policy: PolicyParts;
  readonly environment: EnvironmentParts;
  readonly authorization: AuthorizationParts;
  readonly history: HistoryParts;
  readonly prior: PriorVerdictParts;
  readonly action: ActionParts;
  readonly completeness: CompletenessParts;
}

/** The submission's parts, built once for whichever layout renders them. */
export function submissionParts(snapshot: ReviewSnapshot): SubmissionParts {
  return {
    policy: policyParts(snapshot),
    environment: environmentParts(snapshot),
    authorization: authorizationParts(snapshot),
    history: historyParts(snapshot),
    prior: priorVerdictParts(snapshot),
    action: actionParts(snapshot),
    completeness: completenessParts(snapshot),
  };
}

/** The policy block's production text. */
function policyBlock(parts: PolicyParts): string {
  return [
    'POLICY_AND_GUIDANCE',
    POLICY_NOTE,
    'PROJECT_RULES',
    parts.projectRules ?? NONE_TEXT,
    'CUSTOM_RULES',
    parts.customRules.length > 0 ? parts.customRules : NONE_TEXT,
    json({
      materials: parts.materials,
      project_rules_enabled: parts.projectRulesEnabled,
    }),
  ].join('\n');
}

/** The authorization block's production text. */
function authorizationBlock(parts: AuthorizationParts): string {
  return ['HUMAN_AUTHORIZATION', AUTHORIZATION_NOTE, json(parts)].join('\n');
}

/** The history block's production text. */
function historyBlock(parts: HistoryParts, note: string): string {
  return ['TURN_TOOL_HISTORY', note, json(parts)].join('\n');
}

/** The prior-verdict block's production text. */
function priorVerdictsBlock(parts: PriorVerdictParts): string {
  return ['PRIOR_VERDICTS', json(parts)].join('\n');
}

/** The action block's production text. */
function actionBlock(parts: ActionParts): string[] {
  return [
    ['PENDING_ACTION', json(parts.action)].join('\n'),
    [
      'ACTION_FACTS',
      parts.facts === null ? NO_FACTS_TEXT : json(parts.facts),
    ].join('\n'),
    ...(parts.hint === undefined
      ? []
      : [['REVIEW_HINT', parts.hint].join('\n')]),
  ];
}

/** The completeness block's production text. */
function completenessBlock(parts: CompletenessParts): string {
  return ['MATERIAL_COMPLETENESS', COMPLETENESS_NOTE, json(parts)].join('\n');
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
  const parts = submissionParts(snapshot);
  return [
    // The design's order: the source-labelled policy and environment come first,
    // then the human permission and restrictions they are read against.
    policyBlock(parts.policy),
    ['ENVIRONMENT', json(parts.environment)].join('\n'),
    authorizationBlock(parts.authorization),
    historyBlock(parts.history, HISTORY_NOTE),
    priorVerdictsBlock(parts.prior),
    ...actionBlock(parts.action),
    completenessBlock(parts.completeness),
  ].join('\n\n');
}
