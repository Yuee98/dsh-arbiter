/**
 * Expanding the cache workload into the requests it would send.
 *
 * The design's cache question is a hypothesis about *bytes*: send a cold request, then
 * keep sending requests whose prefix does not change while the action does, and read the
 * provider's own cache counters back. A sequence of role labels cannot answer that, so
 * this module expands the labels into rendered requests and measures the two regions the
 * claim is about:
 *
 *   stable prefix   every block production puts before the action. It has to be
 *                   byte-identical across the workload, or the provider has nothing to
 *                   re-use and the workload measures nothing.
 *   action region   the action block, its derived facts, the hint, and the completeness
 *                   report. This is what a new action changes.
 *
 * The base case supplies everything in the prefix; each step's action case supplies only
 * the action region. That is exactly the situation the design describes — consecutive
 * actions in one session share the policy, environment, authorization and turn history —
 * and it means the workload is built from committed cases rather than invented material.
 *
 * Nothing here sends anything, and nothing here claims a cache hit: the provider's
 * counters are read later, and an unreported counter stays unknown.
 */

import type { ReviewCase } from '../data/types.js';
import { digestOf } from '../data/hash.js';

import type { ReviewSnapshot } from '../../../src/types.js';
import { caseFacts } from '../run/material.js';
import type { RunProtocol } from '../run/types.js';

import type { ResolvedCandidate } from './inspect.js';
import {
  materialFor,
  measuredOf,
  splitAtAction,
  type MaterialCache,
} from './matrix.js';
import type { CacheSlot } from './types.js';

/** One rendered request of the cache workload. */
export interface CacheCell {
  readonly cellId: string;
  readonly role: CacheSlot['role'];
  /** The case whose policy, environment, authorization and history form the prefix. */
  readonly baseCaseId: string;
  /** The case whose action this request submits. */
  readonly actionCaseId: string;
  readonly candidateId: string;
  readonly variantId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly estimatedInputTokens: number;
  /** The exact request's fingerprint. */
  readonly promptFingerprint: string;
  /**
   * The fingerprint of everything before the action block.
   *
   * A prefix cache keys on these bytes, so "the prefix is stable" is checked as an
   * equality between measured fingerprints rather than asserted in the definition's
   * prose. A request whose block boundary could not be located gets `null` here and is
   * refused by {@link cacheProblems}, because a guessed boundary would compare two
   * different things and call the comparison a prefix.
   */
  readonly stablePrefixFingerprint: string | null;
  /** The fingerprint of the action region, which the changed-action slots change. */
  readonly actionFingerprint: string;
  /**
   * The matrix cell that would submit these exact bytes, when one exists.
   *
   * The cold request is the base case's own first matrix cell for this candidate and
   * protocol, so a run that dispatches the matrix first has already sent those bytes.
   * This is recorded as a fact a reader can check; it is **not** a budget offset, because
   * whether the earlier dispatch happened is a property of an execution and not of the
   * plan. Every request here is charged as its own dispatch.
   */
  readonly sameAsMatrixCell: string | null;
  readonly overBudget: boolean;
}

/** The cache workload, expanded and measured. */
export interface CacheExpansion {
  readonly cells: readonly CacheCell[];
  /** How many model requests this workload adds to the matrix. */
  readonly requests: number;
  /** Measured input estimate of the workload, repeats included. */
  readonly estimatedInputTokens: number;
  /**
   * How many of those requests repeat a matrix cell's exact bytes.
   *
   * Reported, never subtracted: a plan charges every request it describes, and a run that
   * can prove an earlier dispatch already covered one saves it at execution time.
   */
  readonly byteIdenticalToMatrix: number;
}

/** One slot's case ids, resolved in order. */
interface CacheStep {
  readonly role: CacheSlot['role'];
  readonly actionCaseId: string;
  readonly repeat: number;
}

/**
 * The sequence as concrete requests.
 *
 * `cold` and `stable-prefix` re-submit the base case's own action; `changed-action`
 * walks `changedActionCaseIds` in order. A repeat index with no matching action is
 * dropped here and reported by {@link cacheProblems}, so a workload that asks for more
 * actions than it declares is refused rather than measured against a repeated case.
 */
export function cacheStepsOf(parts: {
  readonly sequence: readonly CacheSlot[];
  readonly baseCaseId: string;
  readonly changedActionCaseIds: readonly string[];
}): readonly CacheStep[] {
  const steps: CacheStep[] = [];
  for (const slot of parts.sequence) {
    for (let repeat = 1; repeat <= slot.repeats; repeat += 1) {
      const actionCaseId =
        slot.role === 'changed-action'
          ? (parts.changedActionCaseIds[repeat - 1] ?? '')
          : parts.baseCaseId;
      steps.push({ role: slot.role, actionCaseId, repeat });
    }
  }
  return steps;
}

/**
 * The snapshot one cache request submits.
 *
 * The base case's material is production's own, unchanged — that is the prefix. Only the
 * action region is replaced, from the action case. The completeness report stays the base
 * case's own, which is stated in the definition: it describes the submission the prefix
 * belongs to, and carrying it unchanged is what makes "only the action changed" true of
 * the bytes rather than approximately true.
 */
function cacheSnapshot(
  base: ReviewSnapshot,
  actionCase: ReviewCase,
): ReviewSnapshot {
  const input = actionCase.input;
  return {
    ...base,
    action: {
      name: input.action.name,
      arguments: input.action.arguments ?? {},
      ...(input.action.programText === undefined
        ? {}
        : { programText: input.action.programText }),
    },
    facts: caseFacts(actionCase),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
  };
}

/**
 * Expand the cache workload into the requests it would send.
 *
 * `cases` is the dataset's selection; a step whose action case is absent contributes no
 * cell, so a definition naming an unpublished case is reported rather than silently
 * measured against the base case. `matrixCells` is used only to name a request that
 * submits the same bytes, never to skip one.
 */
export function expandCache(parts: {
  readonly candidate: ResolvedCandidate;
  readonly cases: readonly ReviewCase[];
  readonly protocol: RunProtocol;
  readonly baseCaseId: string;
  readonly sequence: readonly CacheSlot[];
  readonly changedActionCaseIds: readonly string[];
  readonly maxInputTokens: number;
  readonly matrixCells?: readonly {
    readonly cellId: string;
    readonly candidateId: string;
    readonly protocol: RunProtocol;
    readonly caseId: string;
    readonly promptFingerprint: string;
  }[];
}): CacheExpansion {
  const byId = new Map(
    parts.cases.map((entry) => [entry.caseId, entry] as const),
  );
  const baseCase = byId.get(parts.baseCaseId);
  if (baseCase === undefined) {
    return {
      cells: [],
      requests: 0,
      estimatedInputTokens: 0,
      byteIdenticalToMatrix: 0,
    };
  }
  const materials: MaterialCache = new Map();
  const base = materialFor(materials, {
    caseEntry: baseCase,
    protocol: parts.protocol,
    maxInputTokens: parts.maxInputTokens,
  });
  const cells: CacheCell[] = [];
  for (const step of cacheStepsOf({
    sequence: parts.sequence,
    baseCaseId: parts.baseCaseId,
    changedActionCaseIds: parts.changedActionCaseIds,
  })) {
    const actionCase = byId.get(step.actionCaseId);
    if (actionCase === undefined) continue;
    const measured = measuredOf(
      { snapshot: cacheSnapshot(base.snapshot, actionCase) },
      { variant: parts.candidate.variant, protocol: parts.protocol },
    );
    const split = splitAtAction(measured.material);
    const same = (parts.matrixCells ?? []).find(
      (cell) =>
        cell.candidateId === parts.candidate.candidateId &&
        cell.protocol === parts.protocol &&
        cell.caseId === step.actionCaseId &&
        cell.promptFingerprint === measured.promptFingerprint,
    );
    cells.push({
      cellId: `cache~${step.role}~${step.actionCaseId}~${parts.protocol}~r${String(step.repeat)}`,
      role: step.role,
      baseCaseId: parts.baseCaseId,
      actionCaseId: step.actionCaseId,
      candidateId: parts.candidate.candidateId,
      variantId: parts.candidate.variant.variantId,
      protocol: parts.protocol,
      repeat: step.repeat,
      estimatedInputTokens: measured.estimatedInputTokens,
      promptFingerprint: measured.promptFingerprint,
      stablePrefixFingerprint:
        split === null
          ? null
          : digestOf({ protocol: parts.protocol, prefix: split.prefix }),
      actionFingerprint: digestOf({
        protocol: parts.protocol,
        action: split === null ? measured.material : split.action,
      }),
      sameAsMatrixCell: same?.cellId ?? null,
      overBudget: measured.overBudget,
    });
  }
  return {
    cells,
    requests: cells.length,
    estimatedInputTokens: cells.reduce(
      (sum, cell) => sum + cell.estimatedInputTokens,
      0,
    ),
    byteIdenticalToMatrix: cells.filter(
      (cell) => cell.sameAsMatrixCell !== null,
    ).length,
  };
}

/**
 * Why an expanded cache workload cannot measure what it claims.
 *
 * Every problem here is about bytes the workload would actually send, not about the
 * definition's wording: a workload whose requests do not share a prefix, whose
 * "changed action" is the same action again, or whose declared repeats exceed the actions
 * it names would produce readings that cannot be attributed to the treatment it describes.
 */
export function cacheProblems(parts: {
  readonly expansion: CacheExpansion;
  readonly definition: {
    readonly sequence: readonly CacheSlot[];
    readonly changedActionCaseIds: readonly string[];
  };
  readonly bounds: { readonly maxInputTokens: number };
}): readonly string[] {
  const problems: string[] = [];
  const { expansion, definition } = parts;
  const cold = expansion.cells.filter((cell) => cell.role === 'cold');
  if (!definition.sequence.some((slot) => slot.role === 'cold')) {
    problems.push(
      'the cache workload names no cold request; a warm-only sequence cannot show what the cache did',
    );
  }
  if (!definition.sequence.some((slot) => slot.role !== 'cold')) {
    problems.push(
      'the cache workload names only cold requests; nothing would be re-used',
    );
  }
  if (expansion.requests < 2) {
    problems.push(
      'the cache workload expands to fewer than two requests; a cold request and one re-use are the minimum that can measure anything',
    );
  }
  // A slot that asks for more repeats than it has actions would repeat one action and
  // report it as a different one. That is refused by counting what the sequence asks for,
  // not by trusting the expansion to have skipped it.
  const changedSlots = definition.sequence.filter(
    (slot) => slot.role === 'changed-action',
  );
  const askedChanged = changedSlots.reduce(
    (sum, slot) => sum + slot.repeats,
    0,
  );
  if (askedChanged > definition.changedActionCaseIds.length) {
    problems.push(
      `the cache workload asks for ${String(askedChanged)} changed action(s) but declares ${String(definition.changedActionCaseIds.length)}; raising a slot's repeats adds real requests and needs real actions`,
    );
  }
  const uniqueChanged = new Set(definition.changedActionCaseIds);
  if (uniqueChanged.size !== definition.changedActionCaseIds.length) {
    problems.push(
      'the cache workload declares the same changed action more than once; two slots submitting one action cannot show that a change was made',
    );
  }
  for (const cell of expansion.cells) {
    if (cell.stablePrefixFingerprint === null) {
      problems.push(
        `cache request ${cell.cellId} carries no locatable action boundary, so its stable prefix cannot be established`,
      );
    }
    if (cell.overBudget) {
      problems.push(
        `cache request ${cell.cellId} is marked OVER_BUDGET by the production budget, so the workload cannot be assembled within ${String(parts.bounds.maxInputTokens)} input tokens`,
      );
    }
  }
  const prefixes = new Set(
    expansion.cells
      .map((cell) => cell.stablePrefixFingerprint)
      .filter((value): value is string => value !== null),
  );
  if (prefixes.size > 1) {
    // The whole workload rests on this: two prefixes mean the provider has nothing
    // stable to re-use, and a cache reading would describe the difference between them
    // rather than the effect of changing the action.
    problems.push(
      `the cache workload submits ${String(prefixes.size)} different stable prefixes; the requests must share one so a provider can re-use it`,
    );
  }
  const baseline = cold[0];
  if (baseline !== undefined) {
    for (const cell of expansion.cells) {
      if (cell.role === 'changed-action') {
        if (cell.actionFingerprint === baseline.actionFingerprint) {
          problems.push(
            `cache request ${cell.cellId} is labelled changed-action but submits the cold request's action unchanged`,
          );
        }
      } else if (cell.actionFingerprint !== baseline.actionFingerprint) {
        problems.push(
          `cache request ${cell.cellId} is labelled ${cell.role} but its action differs from the cold request, so the prefix was not the only stable region`,
        );
      }
    }
  }
  return problems;
}
