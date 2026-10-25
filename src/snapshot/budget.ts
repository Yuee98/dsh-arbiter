/**
 * Input-budget trimming.
 *
 * Optional context is trimmed first and the pending action last: a review is
 * worth more when it can still see what is about to run. Every removal is
 * recorded as an input fact on the snapshot.
 *
 * Two rules keep this module honest:
 *   - every trim step must strictly reduce what is submitted, so the loop
 *     terminates by exhausting material rather than by its guard;
 *   - the budget is checked against both reviewer payloads (chat text and the
 *     decision state plus questions), so a snapshot that fits chat cannot
 *     surprise the decision backend.
 *
 * A trimmed request is still a normal review: truncation never throws, never
 * becomes an error stage and never adds a review chain stage. A request that
 * cannot be assembled within budget no longer pretends to fit — it is reported
 * as `OVER_BUDGET` for the caller to treat as a real preparation failure.
 */
import { estimateTokenCount } from 'tokenx';
import {
  buildQuestions,
  renderDecisionState,
  renderSystem,
  renderUser,
} from '../reviewer.js';
import type {
  ActionTruncation,
  ReviewSnapshot,
  SnapshotMaterial,
} from '../types.js';

/** Fields that carry submitted program text in the host's tool schemas. */
const ACTION_TEXT_FIELDS = ['code', 'program', 'command'] as const;

/** Keep enough of the trimmed action for a review to still see its shape. */
const MIN_ACTION_CHARS = 32;

const ACTION_TRUNCATED =
  'the pending action text was truncated by the input budget; the original request is preserved separately';

interface BudgetState {
  evidence: ReviewSnapshot['evidence'];
  context: ReviewSnapshot['context'];
  checkpoints: ReviewSnapshot['checkpoints'];
  prior: ReviewSnapshot['priorVerdicts'];
  projectRules: ReviewSnapshot['projectRules'];
  materials: readonly SnapshotMaterial[];
  facts: ReviewSnapshot['facts'];
  action: ReviewSnapshot['action'];
  evidenceTruncated: boolean;
  contextTruncated: boolean;
  historyTruncated: boolean;
  readonly missing: Set<string>;
  readonly truncatedSegments: Set<string>;
}

function prunedProjectRulesMaterial(
  materials: readonly SnapshotMaterial[],
): readonly SnapshotMaterial[] {
  return materials.map((material) =>
    material.id === 'project-rules'
      ? { ...material, present: false, chars: 0 }
      : material,
  );
}

function candidateSnapshot(
  base: Omit<ReviewSnapshot, 'budget'>,
  state: BudgetState,
  maxInputTokens: number,
): ReviewSnapshot {
  return {
    ...base,
    action: state.action,
    materials: state.materials,
    missing: [...state.missing],
    evidence: state.evidence,
    context: state.context,
    checkpoints: state.checkpoints,
    priorVerdicts: state.prior,
    projectRules: state.projectRules,
    facts: state.facts,
    evidenceTruncated: state.evidenceTruncated,
    contextTruncated: state.contextTruncated,
    historyTruncated: state.historyTruncated,
    budget: {
      maxInputTokens,
      estimatedInputTokens: 0,
      truncatedSegments: [...state.truncatedSegments],
    },
  };
}

function truncationOf(
  originalChars: number,
  retainedChars: number,
  field: string | null,
): ActionTruncation {
  return {
    originalChars,
    retainedChars,
    field,
    omittedFrom: retainedChars,
    omittedTo: originalChars - 1,
  };
}

function asTextRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : null;
}

/** The text currently submitted for the trimmed field, or the whole payload. */
function currentActionText(action: ReviewSnapshot['action']): {
  readonly field: string | null;
  readonly text: string;
} | null {
  const chosen = action.truncated?.field ?? null;
  const value = action.arguments;
  const record = asTextRecord(value);
  if (record !== null) {
    const field =
      chosen ??
      ACTION_TEXT_FIELDS.find((name) => {
        const candidate = record[name];
        return typeof candidate === 'string' && candidate.length > 0;
      });
    if (field !== undefined) {
      const text = record[field];
      if (typeof text === 'string') return { field, text };
    }
    return { field: null, text: JSON.stringify(record) };
  }
  if (typeof value === 'string') return { field: chosen, text: value };
  if (value === null || value === undefined) return null;
  return { field: null, text: JSON.stringify(value) };
}

function currentTextOf(
  action: ReviewSnapshot['action'],
  field: string | null,
): string {
  const value = action.arguments;
  const record = asTextRecord(value);
  if (field !== null && record !== null) {
    const text = record[field];
    if (typeof text === 'string') return text;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

/**
 * Rewrite the submitted action with a shorter head.
 *
 * `programText` is a second copy of the same program, so it must shrink with
 * `arguments`; otherwise a large program would still travel in full and the
 * recorded truncation range would not describe the submission.
 */
function shrinkAction(
  action: ReviewSnapshot['action'],
  field: string | null,
  originalChars: number,
  keep: number,
): ReviewSnapshot['action'] {
  const head = currentTextOf(action, field).slice(0, keep);
  const record = asTextRecord(action.arguments);
  const next =
    field !== null && record !== null ? { ...record, [field]: head } : head;
  const isProgram = field === 'code' || field === 'program';
  return {
    ...action,
    arguments: next,
    ...(isProgram || action.programText !== undefined
      ? { programText: head }
      : {}),
    truncated: truncationOf(originalChars, keep, field),
  };
}

/**
 * Trim the action only after every optional segment is gone. Repeated halving
 * keeps it inside the budget instead of stopping at a single cut.
 */
function trimAction(state: BudgetState): boolean {
  const current = currentActionText(state.action);
  if (current === null) return false;
  const originalChars =
    state.action.truncated?.originalChars ?? current.text.length;
  if (originalChars <= MIN_ACTION_CHARS) return false;
  const keep = Math.floor(current.text.length / 2);
  if (keep < Math.min(MIN_ACTION_CHARS, originalChars)) return false;
  state.action = shrinkAction(state.action, current.field, originalChars, keep);
  state.truncatedSegments.add('ACTION');
  state.missing.add(ACTION_TRUNCATED);
  return true;
}

function trimCheckpoints(state: BudgetState): boolean {
  if (state.checkpoints.length === 0) return false;
  state.checkpoints = state.checkpoints.slice(0, -1);
  state.contextTruncated = true;
  state.truncatedSegments.add('CONTEXT');
  state.missing.add('checkpoint summaries were truncated by the input budget');
  return true;
}

/**
 * Remove one segment in the documented budget priority order. Each branch
 * either shrinks the submission or clears a field, so a later call cannot
 * re-enter the same branch with unchanged material.
 */
function truncateNext(state: BudgetState): boolean {
  if (state.context.length > 0) {
    state.context = state.context.slice(0, -1);
    state.contextTruncated = true;
    state.truncatedSegments.add('CONTEXT');
    state.missing.add(
      'prior tool-call context was truncated by the input budget',
    );
    return true;
  }
  if (trimCheckpoints(state)) return true;
  if (state.prior.length > 0) {
    state.prior = state.prior.slice(0, -1);
    state.historyTruncated = true;
    state.truncatedSegments.add('PRIOR_VERDICTS');
    state.missing.add('prior verdicts were truncated by the input budget');
    return true;
  }
  if (state.evidence.length > 1) {
    state.evidence = state.evidence.slice(0, -1);
    state.evidenceTruncated = true;
    state.truncatedSegments.add('EVIDENCE');
    state.missing.add(
      'authorization evidence was truncated by the input budget',
    );
    return true;
  }
  if (state.projectRules !== null) {
    state.projectRules = null;
    state.materials = prunedProjectRulesMaterial(state.materials);
    state.truncatedSegments.add('PROJECT_RULES');
    state.missing.add('PROJECT_RULES was omitted by the input budget');
    return true;
  }
  if (state.facts !== null) {
    const facts = state.facts;
    const emptied = {
      ...facts,
      observed: {
        writes: [],
        networkCommands: [],
        credentialPaths: [],
        pipelineExec: [],
        substitutions: facts.observed.substitutions,
        subshells: facts.observed.subshells,
      },
      completeness:
        facts.completeness === 'complete' ? 'partial' : facts.completeness,
      truncated: true,
    };
    // A second pass must be able to make progress: drop the block entirely
    // rather than re-reporting an already-trimmed object.
    state.facts = facts.truncated === true ? null : emptied;
    state.truncatedSegments.add('DERIVED_FACTS');
    state.missing.add('derived facts were reduced by the input budget');
    return true;
  }
  return trimAction(state);
}

interface RenderedRequest {
  readonly snapshot: ReviewSnapshot;
  readonly system: string;
  readonly user: string;
}

/** Estimated tokens of each payload actually sent to a reviewer backend. */
function estimatePayloads(
  chatSystem: string,
  chatUser: string,
): { readonly chat: number; readonly decision: number } {
  const decision = renderDecisionState(chatUser);
  return {
    chat: estimateTokenCount(chatSystem) + estimateTokenCount(chatUser),
    decision:
      estimateTokenCount(decision) +
      estimateTokenCount(JSON.stringify(buildQuestions())),
  };
}

/**
 * Render the final request from the exact snapshot that gets persisted.
 *
 * The budget block itself carries the estimate, so the number is written back
 * and the payloads re-rendered until stable. Otherwise the stored snapshot and
 * the model's copy would disagree on `estimated_input_tokens`.
 */
function renderedSnapshot(candidate: ReviewSnapshot): RenderedRequest {
  let snapshot = candidate;
  let system = renderSystem();
  let user = renderUser(snapshot);
  let payloads = estimatePayloads(system, user);
  for (let round = 0; round < 5; round += 1) {
    const estimated = Math.max(payloads.chat, payloads.decision);
    const over = estimated > candidate.budget.maxInputTokens;
    const withBudget: ReviewSnapshot = {
      ...candidate,
      budget: {
        ...candidate.budget,
        estimatedInputTokens: estimated,
        truncatedSegments: [
          ...new Set([
            ...candidate.budget.truncatedSegments,
            ...(over ? ['OVER_BUDGET'] : []),
          ]),
        ],
      },
    };
    const nextSystem = renderSystem();
    const nextUser = renderUser(withBudget);
    const nextPayloads = estimatePayloads(nextSystem, nextUser);
    const stable =
      Math.max(nextPayloads.chat, nextPayloads.decision) === estimated;
    snapshot = withBudget;
    system = nextSystem;
    user = nextUser;
    payloads = nextPayloads;
    if (stable) break;
  }
  return { snapshot, system, user };
}

/**
 * Whether this state still exceeds the budget, judged on the **stabilized**
 * payload.
 *
 * The budget block itself contains the estimate, so writing the number back
 * changes the rendered size. Comparing the provisional render (which carries
 * `estimatedInputTokens: 0`) can report a fit that the final text does not have;
 * that would turn a satisfiable request into a false preparation failure. This
 * measures exactly what `renderedSnapshot` would submit.
 */
function overBudget(
  base: Omit<ReviewSnapshot, 'budget'>,
  state: BudgetState,
  maxInputTokens: number,
): boolean {
  const rendered = renderedSnapshot(
    candidateSnapshot(base, state, maxInputTokens),
  );
  return rendered.snapshot.budget.estimatedInputTokens > maxInputTokens;
}

export function truncateSnapshot(
  base: Omit<ReviewSnapshot, 'budget'>,
  maxInputTokens: number,
): RenderedRequest {
  const state: BudgetState = {
    evidence: [...base.evidence],
    context: [...base.context],
    checkpoints: [...base.checkpoints],
    prior: [...base.priorVerdicts],
    projectRules: base.projectRules,
    materials: base.materials,
    facts: base.facts,
    action: base.action,
    evidenceTruncated: base.evidenceTruncated,
    contextTruncated: base.contextTruncated,
    historyTruncated: base.historyTruncated,
    missing: new Set(base.missing),
    truncatedSegments: new Set(),
  };
  // The loop is bounded by removable material, not by a fixed iteration count:
  // legal configurations can hold far more than 500 candidate items, and a
  // premature stop would report a fit that was never reached. Each successful
  // trim removes exactly one item or shrinks the action, so the total work is
  // O(items + action halvings).
  const maxSteps =
    base.evidence.length +
    base.context.length +
    base.checkpoints.length +
    base.priorVerdicts.length +
    4 +
    // Enough halvings for the action to reach its minimum floor.
    64;
  for (let step = 0; step < maxSteps; step += 1) {
    if (!overBudget(base, state, maxInputTokens)) {
      return renderedSnapshot(candidateSnapshot(base, state, maxInputTokens));
    }
    if (!truncateNext(state)) break;
  }
  return renderedSnapshot(candidateSnapshot(base, state, maxInputTokens));
}
