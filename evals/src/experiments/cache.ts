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
 * The composition happens at the *case* level, not the snapshot level. A step's request is
 * a case whose identity, policy, evidence, session and working directory are the base
 * case's and whose action is the action case's; that composed case then goes through
 * `caseMaterial`, which is the production path: evaluate the facts, assemble the snapshot,
 * trim it against the input budget, build the completeness report, render. Two
 * consequences make the workload honest rather than approximate:
 *
 *   - derived facts are evaluated in the directory the reviewer is told the call runs in.
 *     A relative path resolves against that directory, so deriving facts from the action
 *     case's own `cwd` would submit a command line and a write target that describe two
 *     different directories.
 *   - the composed request is trimmed by production's own budget step, so a larger action
 *     is bounded exactly as production would bound it and `OVER_BUDGET` describes the
 *     request that would actually be sent rather than the base case it replaced.
 *
 * Nothing here sends anything, and nothing here claims a cache hit: the provider's
 * counters are read later, and an unreported counter stays unknown.
 */

import type { ReviewCase } from '../data/types.js';
import { digestOf } from '../data/hash.js';

import { caseMaterial } from '../run/material.js';
import type { RunProtocol } from '../run/types.js';

import type { ResolvedCandidate } from './inspect.js';
import { measuredOf } from './matrix.js';
import { splitAtAction } from './matrix.js';
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
  /** Whether production's budget marked this exact request over its own bind. */
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

/** One slot's resolved request, in the order the sequence asks for it. */
interface CacheStep {
  readonly role: CacheSlot['role'];
  readonly actionCaseId: string;
  readonly repeat: number;
}

/**
 * The sequence as concrete requests, in order.
 *
 * The changed-action cursor is cumulative across slots, not reset per slot: splitting one
 * `changed-action × 2` into two `× 1` slots has to submit two different actions, because a
 * workload that submits the same action twice cannot show that an action changed.
 */
export function cacheStepsOf(parts: {
  readonly sequence: readonly CacheSlot[];
  readonly baseCaseId: string;
  readonly changedActionCaseIds: readonly string[];
}): readonly CacheStep[] {
  const steps: CacheStep[] = [];
  let cursor = 0;
  for (const slot of parts.sequence) {
    for (let repeat = 1; repeat <= slot.repeats; repeat += 1) {
      if (slot.role === 'changed-action') {
        cursor += 1;
        steps.push({
          role: slot.role,
          actionCaseId: parts.changedActionCaseIds[cursor - 1] ?? '',
          repeat,
        });
        continue;
      }
      steps.push({
        role: slot.role,
        actionCaseId: parts.baseCaseId,
        repeat,
      });
    }
  }
  return steps;
}

/**
 * The case one cache request submits.
 *
 * Identity, policy, evidence, session, tool and working directory are the base case's, so
 * every block production emits before the action is byte-identical. The action, its
 * derived facts and the hint are the action case's, evaluated in the base case's
 * directory. The base case's hint is dropped rather than inherited: it would point at an
 * action this request does not submit.
 */
export function composedCase(
  base: ReviewCase,
  actionCase: ReviewCase,
): ReviewCase {
  const { hint: _inherited, ...baseInput } = base.input;
  return {
    ...base,
    input: {
      ...baseInput,
      action: actionCase.input.action,
      ...(actionCase.input.hint === undefined
        ? {}
        : { hint: actionCase.input.hint }),
    },
  };
}

/**
 * Expand the cache workload into the requests it would send.
 *
 * `cases` is the dataset's selection. A step whose action case is absent contributes no
 * cell and is reported by {@link cacheProblems}, so a definition naming an unpublished
 * case is refused rather than silently measured against the base case. `matrixCells` is
 * used only to name a request that submits the same bytes, never to skip one.
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
  const cells: CacheCell[] = [];
  for (const step of cacheStepsOf({
    sequence: parts.sequence,
    baseCaseId: parts.baseCaseId,
    changedActionCaseIds: parts.changedActionCaseIds,
  })) {
    const actionCase = byId.get(step.actionCaseId);
    if (actionCase === undefined) continue;
    // The composed case goes through the production composition and trim, so the request
    // is bounded and reported exactly as production would bound and report it.
    const material = caseMaterial(
      composedCase(baseCase, actionCase),
      parts.protocol,
      { maxInputTokens: parts.maxInputTokens },
    );
    const measured = measuredOf(
      { snapshot: material.snapshot },
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

/** The action cases a sequence names that the selection does not publish. */
export function missingActionCasesOf(parts: {
  readonly sequence: readonly CacheSlot[];
  readonly baseCaseId: string;
  readonly changedActionCaseIds: readonly string[];
  readonly caseIds: readonly string[];
}): readonly string[] {
  const published = new Set(parts.caseIds);
  const named = new Set<string>();
  for (const step of cacheStepsOf(parts)) {
    if (step.actionCaseId !== '' && !published.has(step.actionCaseId)) {
      named.add(step.actionCaseId);
    }
  }
  return [...named];
}

/**
 * Why an expanded cache workload cannot measure what it claims.
 *
 * Every problem here is about bytes the workload would actually send, not about the
 * definition's wording: a workload that expands to fewer requests than it declares, whose
 * requests do not share a prefix, whose "changed action" is the same action again, or
 * whose requests exceed the per-request ceiling would produce readings that cannot be
 * attributed to the treatment it describes.
 */
export function cacheProblems(parts: {
  readonly expansion: CacheExpansion;
  readonly definition: {
    readonly sequence: readonly CacheSlot[];
    readonly baseCaseId: string;
    readonly changedActionCaseIds: readonly string[];
  };
  readonly bounds: { readonly maxInputTokens: number };
  /** The case ids the dataset selection publishes, for the action-id check. */
  readonly caseIds?: readonly string[];
}): readonly string[] {
  const problems: string[] = [];
  const { expansion, definition } = parts;
  const cold = expansion.cells.filter((cell) => cell.role === 'cold');
  const changedSlots = definition.sequence.filter(
    (slot) => slot.role === 'changed-action',
  );
  if (!definition.sequence.some((slot) => slot.role === 'cold')) {
    problems.push(
      'the cache workload names no cold request; a warm-only sequence cannot show what the cache did',
    );
  }
  if (changedSlots.length === 0) {
    // The changing action is one of the three things the issue names. A workload without
    // it measures a prefix re-use and nothing about whether the action moved.
    problems.push(
      'the cache workload names no changed-action request; the experiment needs a cold request, a stable-prefix re-use and a changing action',
    );
  }
  if (!definition.sequence.some((slot) => slot.role !== 'cold')) {
    problems.push(
      'the cache workload names only cold requests; nothing would be re-used',
    );
  }
  // What the definition declares has to be what the expansion produced. A request that
  // silently disappeared would make the record certify a smaller experiment than the
  // definition describes.
  const declaredRequests = definition.sequence.reduce(
    (sum, slot) => sum + slot.repeats,
    0,
  );
  if (expansion.requests !== declaredRequests) {
    problems.push(
      `the cache workload declares ${String(declaredRequests)} request(s) but expands to ${String(expansion.requests)}; every declared request has to name material a run could send`,
    );
  }
  const declaredChanged = changedSlots.reduce(
    (sum, slot) => sum + slot.repeats,
    0,
  );
  const expandedChanged = expansion.cells.filter(
    (cell) => cell.role === 'changed-action',
  ).length;
  if (expandedChanged !== declaredChanged) {
    problems.push(
      `the cache workload declares ${String(declaredChanged)} changed-action request(s) but expands to ${String(expandedChanged)}`,
    );
  }
  if (declaredChanged > definition.changedActionCaseIds.length) {
    problems.push(
      `the cache workload asks for ${String(declaredChanged)} changed action(s) but declares ${String(definition.changedActionCaseIds.length)}; a slot's repeats add real requests and need real actions`,
    );
  }
  const uniqueChanged = new Set(definition.changedActionCaseIds);
  if (uniqueChanged.size !== definition.changedActionCaseIds.length) {
    problems.push(
      'the cache workload declares the same changed action more than once; two slots submitting one action cannot show that a change was made',
    );
  }
  for (const caseId of missingActionCasesOf({
    sequence: definition.sequence,
    baseCaseId: definition.baseCaseId,
    changedActionCaseIds: definition.changedActionCaseIds,
    caseIds: parts.caseIds ?? [],
  })) {
    problems.push(
      `the cache workload names action case ${caseId}, which the experiment's dataset selection does not publish`,
    );
  }
  for (const cell of expansion.cells) {
    if (cell.stablePrefixFingerprint === null) {
      problems.push(
        `cache request ${cell.cellId} carries no locatable action boundary, so its stable prefix cannot be established`,
      );
    }
    // The per-request ceiling is checked against the measured request, not only against
    // the production flag: a composed action can be larger than the base case's, and a
    // flag inherited from a smaller submission would not describe this one.
    if (cell.estimatedInputTokens > parts.bounds.maxInputTokens) {
      problems.push(
        `cache request ${cell.cellId} measures ${String(cell.estimatedInputTokens)} input tokens against a per-request ceiling of ${String(parts.bounds.maxInputTokens)}; the run would refuse it rather than send it`,
      );
    }
    if (cell.overBudget) {
      problems.push(
        `cache request ${cell.cellId} is marked OVER_BUDGET by the production budget, so it cannot be assembled within the per-request ceiling of ${String(parts.bounds.maxInputTokens)} input tokens`,
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
  const actions = new Set(
    expansion.cells
      .filter((cell) => cell.role === 'changed-action')
      .map((cell) => cell.actionFingerprint),
  );
  if (expandedChanged > 0 && actions.size !== expandedChanged) {
    problems.push(
      `the cache workload submits ${String(expandedChanged)} changed-action request(s) but only ${String(actions.size)} distinct action(s); each changed slot has to submit its own action`,
    );
  }
  return problems;
}
