/**
 * Prior-verdict selection and the durable record codec.
 *
 * Runtime memory, the session log and the SQLite audit are three views of the
 * same logical verdict, so they must agree on what counts as one. This module
 * owns the single definition used by all three:
 *
 *   - one predicate deciding which results are prior-verdict candidates;
 *   - one identity (the tool `callId`) so a call never occupies the window
 *     twice, whatever wrote it;
 *   - one ordering (`ts`, then `callId`) so the same population always yields
 *     the same window, before and after a restart;
 *   - one phase-chain rule that keeps the longer known chain, never invents a
 *     stage, and reports disagreement instead of resolving it toward allow or
 *     deny.
 *
 * The codec reads the payloads already written by shipped builds, so records
 * that exist today stay interpretable.
 */

import type { CallResult, PriorVerdictItem } from '../types.js';

/** The record type this plugin writes into the session log. */
export const DECISION_RECORD = 'plugin:arbiter/decision';

/**
 * The record type announcing an explicit runtime-history reset.
 *
 * A reset that only lives in memory is undone by the next restart, because both
 * durable sources still hold the withdrawn verdicts. Writing the barrier into
 * the same log keeps "the user reset this history" a recoverable fact without
 * adding a database table, a UI action or a public API.
 */
export const HISTORY_RESET_RECORD = 'plugin:arbiter/history-reset';

/** The payload version this build writes; older payloads are still read. */
export const DECISION_RECORD_VERSION = 2;

/**
 * Results that are NOT prior-verdict candidates.
 *
 * This is the established selection condition: a call that was allowed says
 * nothing about how a later call should be judged, and its execution record is
 * already carried by the host tool-call history. Everything else — a rule
 * denial, a review denial, an escalation to a human, a human decision, and a
 * fallback denial — is a real prior outcome worth showing.
 *
 * Written as a denial list rather than a candidate list on purpose: it is the
 * predicate the audit store has always used, so adopting it for memory and for
 * session records aligns the three sources without changing what SQLite
 * returns.
 */
const NOT_A_PRIOR_VERDICT: ReadonlySet<string> = new Set([
  'allow',
  'review-allow',
  'human-allow',
  // Cancelled before anything was decided: there is no verdict to carry forward,
  // and offering "cancelled" as precedent would misdescribe later calls.
  'review-cancelled',
]);

/** Whether one logical call belongs in the prior-verdict window. */
export function isPriorVerdictCandidate(result: string): boolean {
  return !NOT_A_PRIOR_VERDICT.has(result);
}

/**
 * Stable ordering: oldest first, ties broken by identity.
 *
 * `ts` alone is not enough — two calls can be recorded in the same millisecond,
 * and a source that returns them in a different order would otherwise produce a
 * different window after a restart.
 */
export function comparePriorVerdicts(
  left: PriorVerdictItem,
  right: PriorVerdictItem,
): number {
  if (left.ts !== right.ts) return left.ts - right.ts;
  return left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0;
}

/**
 * One phase chain, completed from both sources' views of the same call.
 *
 * A chain is only ever a subsequence of a real chain: the longer observed chain
 * wins because a source that saw more stages cannot be missing one it recorded.
 * When both observed the same stage count but disagree on a stage result, the
 * chain is conflicted: both readings are kept and the caller marks the entry,
 * because choosing one would fabricate a decision that never happened.
 */
export interface ChainResolution {
  readonly trace: readonly string[];
  /** Stage results whose two observations disagree, with both readings. */
  readonly conflicts: readonly {
    readonly index: number;
    readonly observed: readonly string[];
  }[];
}

function sameLengthConflict(
  left: readonly string[],
  right: readonly string[],
): ChainResolution['conflicts'] {
  const conflicts: { index: number; observed: string[] }[] = [];
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    conflicts.push({
      index,
      observed: [a ?? '', b ?? ''],
    });
  }
  return conflicts;
}

/**
 * Merge two observations of one call's phase chain.
 *
 * `left` and `right` are the stage-result lists each source retained. An empty
 * observation contributes nothing. The longer chain is kept; a genuine
 * disagreement is reported, never averaged or trimmed to hide it.
 */
export function resolveChain(
  left: readonly string[],
  right: readonly string[],
): ChainResolution {
  if (left.length === 0) return { trace: [...right], conflicts: [] };
  if (right.length === 0) return { trace: [...left], conflicts: [] };
  if (left.length === right.length) {
    return { trace: [...left], conflicts: sameLengthConflict(left, right) };
  }
  const longer = left.length > right.length ? left : right;
  const shorter = left.length > right.length ? right : left;
  // The shorter chain must be a prefix of the longer one; anything else means
  // the two sources describe genuinely different stage sequences.
  const prefixAgrees = shorter.every((stage, index) => longer[index] === stage);
  return {
    trace: [...longer],
    conflicts: prefixAgrees ? [] : sameLengthConflict(shorter, longer),
  };
}

/** Whether a shared scalar disagrees between two observations of one call. */
/** Report a disagreement on one named field of a stored stage. */
function stageFieldConflict(
  at: string,
  suffix: 'result' | 'reason' | 'ruleId',
  left: string,
  right: string,
): FieldConflict | null {
  if (left === right) return null;
  // The name is composed from the prefix and the suffix, never re-parsed, so it
  // always reads `stages[0].reason` and stays assignable to the declared shape.
  return { field: `${at}.${suffix}`, observed: [left, right] };
}

/**
 * A disagreement's name.
 *
 * Call-level fields are bare names (`tool`, `result`, `trace`, …); a disagreement
 * inside a stored stage is `stages[i].<field>`, so the reviewer can see which
 * stage of the chain the two sources describe differently. The nested form needs
 * a free-form string because the stage index is data, not a type.
 */
export type ConflictField = string;

export interface FieldConflict {
  /**
   * Which observation differed.
   *
   * Call-level fields are bare names; a disagreement inside a stored stage is
   * named `stages[i].<field>` so the reviewer can see which stage of the chain
   * the two sources describe differently.
   */
  readonly field: ConflictField;
  readonly observed: readonly string[];
}

/** A conflict only when both observations actually carry a value. */
function bothPresent(
  field: 'reason' | 'ruleId',
  left: string | undefined,
  right: string | undefined,
): FieldConflict | null {
  if (left === undefined || right === undefined) return null;
  return fieldConflict(field, left, right);
}

function fieldConflict(
  field: FieldConflict['field'],
  left: string,
  right: string,
): FieldConflict | null {
  if (left === right || left.length === 0 || right.length === 0) return null;
  return { field, observed: [left, right] };
}

/**
 * Compare the fields two sources both recorded for the same call.
 *
 * Only fields that carry a decision's identity are compared: a differing
 * `reason` is wording that may legitimately differ between a live render and a
 * stored copy, while a differing `result` is the decision itself. A conflict is
 * reported so the reviewer sees both readings; the entry keeps the first
 * source's value rather than picking the more permissive one.
 */
export function fieldConflicts(
  left: PriorVerdictItem,
  right: PriorVerdictItem,
): readonly FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const conflict of [
    fieldConflict('tool', left.tool, right.tool),
    fieldConflict('fingerprint', left.fingerprint, right.fingerprint),
    fieldConflict('configRevision', left.configRevision, right.configRevision),
    fieldConflict('result', left.result, right.result),
    // A reason both sources recorded and that differs describes two accounts of
    // the same decision, so it is reported rather than overwritten. A field only
    // one side stored is not a disagreement: absence is missing evidence, and
    // treating it as a conflicting value would make every partial source look
    // like a contradiction.
    bothPresent('reason', left.reason, right.reason),
    bothPresent('ruleId', left.ruleId, right.ruleId),
  ]) {
    if (conflict !== null) conflicts.push(conflict);
  }
  return conflicts;
}

/** Fill optional fields the first observation lacks from the second. */
function fillFrom(
  kept: PriorVerdictItem,
  other: PriorVerdictItem,
): PriorVerdictItem {
  return {
    ...kept,
    ...(kept.reason === undefined && other.reason !== undefined
      ? { reason: other.reason }
      : {}),
    ...(kept.ruleId === undefined && other.ruleId !== undefined
      ? { ruleId: other.ruleId }
      : {}),
    ...(kept.decisionRules === undefined && other.decisionRules !== undefined
      ? { decisionRules: other.decisionRules }
      : {}),
    ...(kept.effect === undefined && other.effect !== undefined
      ? { effect: other.effect }
      : {}),
    // Richer stage evidence is additive: whichever observation carries the
    // longer real chain supplies it, and a chain that is only a result list does
    // not displace one that has each stage's own reason and rule.
    ...(kept.stages === undefined && other.stages !== undefined
      ? { stages: other.stages }
      : {}),
    ...(kept.stages !== undefined &&
    other.stages !== undefined &&
    other.stages.length > kept.stages.length
      ? { stages: other.stages }
      : {}),
  };
}

/**
 * Per-stage disagreements between two real chains.
 *
 * Two sources that both stored structured stages can agree on the result of a
 * stage while recording different reasons or rules for it. Those are reported as
 * a field conflict on that stage, and a field one side never stored is treated as
 * unknown rather than as equal: absence is not agreement.
 */
function stageConflicts(
  left: readonly NonNullable<PriorVerdictItem['stages']>[number][],
  right: readonly NonNullable<PriorVerdictItem['stages']>[number][],
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) continue;
    const at = `stages[${String(index)}]`;
    for (const [suffix, leftValue, rightValue] of [
      ['result', a.result, b.result],
      ['reason', a.reason ?? '', b.reason ?? ''],
    ] as const) {
      const conflict = stageFieldConflict(at, suffix, leftValue, rightValue);
      if (conflict !== null) conflicts.push(conflict);
    }
  }
  return conflicts;
}

/**
 * Combine two observations of one logical call.
 *
 * The result comes from the observation that owns the entry (`kept`), so a
 * merge never changes a conclusion; only evidence about that call is added.
 * `kept` also keeps its `ts`, because a verdict's own time is when the decision
 * was made, not when a later source happened to re-store it.
 */
export function mergeObservations(
  kept: PriorVerdictItem,
  other: PriorVerdictItem,
): PriorVerdictItem {
  const chain = resolveChain(kept.trace, other.trace);
  const conflicts = [
    ...fieldConflicts(kept, other),
    ...chain.conflicts.map((conflict) => ({
      field: 'trace' as const,
      observed: conflict.observed,
    })),
    ...(kept.stages === undefined || other.stages === undefined
      ? []
      : stageConflicts(kept.stages, other.stages)),
  ];
  const merged = fillFrom(kept, other);
  // `other` may itself be an aggregate that already folded several observations.
  // Its evidence and its truncation fact are part of the call's history, so both
  // are merged rather than replaced: carrying only `kept`'s view would silently
  // drop a known gap.
  const combined = addConflicts(merged.conflicts, [
    ...(other.conflicts ?? []),
    ...conflicts,
  ]);
  return {
    ...merged,
    trace: chain.trace,
    // More disagreement was observed than one entry can represent. The fact rides
    // on the entry itself, so it shares the entry's session scope and capacity
    // lifetime: a call the window dropped takes its flag with it, and no other
    // session can observe it.
    ...(combined.bounded ||
    kept.conflictsTruncated === true ||
    other.conflictsTruncated === true
      ? { conflictsTruncated: true }
      : {}),
    ...(combined.conflicts.length === 0
      ? {}
      : { conflicts: combined.conflicts }),
  };
}

/**
 * At most one entry per conflicting field, and at most two observed values.
 *
 * A long session can record the same call many times, and appending every
 * disagreement would make the evidence grow with the duplicate count even though
 * the entry itself is bounded. The first two readings of a field are kept — that
 * is what a contradiction is — and any further, different reading is folded into
 * a single `overlapping` note rather than stored. `bounded` tells the caller that
 * more was observed than can be represented, which is reported as a completeness
 * limit instead of being silently dropped.
 */
function addConflicts(
  existing: PriorVerdictItem['conflicts'],
  incoming: readonly {
    readonly field: string;
    readonly observed: readonly string[];
  }[],
): {
  readonly conflicts: readonly {
    readonly field: string;
    readonly observed: readonly string[];
  }[];
  readonly bounded: boolean;
} {
  const byField = new Map<string, readonly string[]>();
  for (const conflict of existing ?? []) {
    byField.set(conflict.field, conflict.observed);
  }
  let bounded = false;
  for (const conflict of incoming) {
    const known = byField.get(conflict.field);
    if (known === undefined) {
      byField.set(conflict.field, [...new Set(conflict.observed)].slice(0, 2));
      continue;
    }
    const merged = [...new Set([...known, ...conflict.observed])];
    if (merged.length > 2) bounded = true;
    byField.set(conflict.field, merged.slice(0, 2));
  }
  return {
    conflicts: [...byField].map(([field, observed]) => ({ field, observed })),
    bounded,
  };
}

/**
 * Deduplicate and trim one population to a stable window.
 *
 * Input order is irrelevant: the window is decided by `comparePriorVerdicts`,
 * so two sources listing the same calls differently still produce the same
 * last-N set. `truncated` reports whether the window dropped a candidate, which
 * is the only thing that may legitimately set it.
 *
 * Two observations of one call are merged before the candidate filter runs. If
 * they disagree about the result, the merged entry keeps the disagreement and
 * counts as a candidate: dropping it because one reading happened to be an
 * allow would hide the conflict behind a filter.
 */
export function selectWindow(
  items: readonly PriorVerdictItem[],
  limit: number,
): { readonly selected: PriorVerdictItem[]; readonly truncated: boolean } {
  const bounded = Math.max(1, limit);
  const byId = new Map<string, PriorVerdictItem>();
  for (const item of items) {
    const existing = byId.get(item.callId);
    byId.set(
      item.callId,
      existing === undefined ? item : mergeObservations(existing, item),
    );
  }
  const candidates = [...byId.values()].filter(
    (item) =>
      isPriorVerdictCandidate(item.result) ||
      (item.conflicts ?? []).some((conflict) => conflict.field === 'result'),
  );
  const ordered = candidates.sort(comparePriorVerdicts);
  return {
    selected: ordered.slice(-bounded),
    truncated: candidates.length > bounded,
  };
}

/** One decoded decision record, before it becomes a `PriorVerdictItem`. */
export interface DecisionRecord {
  readonly callId: string;
  readonly ts: number;
  readonly configRevision: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly trace: readonly string[];
  readonly result: CallResult;
  readonly reason?: string;
  readonly ruleId?: string;
  readonly decisionRules?: readonly string[];
}

const CALL_RESULTS: readonly CallResult[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
  'review-allow',
  'review-deny',
  'review-escalate',
  'human-allow',
  'human-deny',
  'human-abort',
  'fallback-deny',
  // A cancellation that arrived after the request was sent. It is a result, so a
  // durable reader must recognize it; it is not a verdict, so it is excluded from
  // the prior-verdict window below. Without this entry the record was rejected by
  // both durable sources and surfaced as an uninterpretable-history gap.
  'review-cancelled',
];

/** Narrow an unknown value to a known decision result. */
export function asCallResult(value: unknown): CallResult | null {
  return typeof value === 'string'
    ? (CALL_RESULTS.find((entry) => entry === value) ?? null)
    : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : null;
}

/**
 * Build the payload written for one decision.
 *
 * `trace` is the real observed stage chain, including stage names, so a reader
 * is not asked to reconstruct it. Version 2 adds the stage names and keeps every
 * field version 1 carried, so a v2 record is still readable by a v1 reader that
 * only looks at `trace`/`result`.
 */
export function decisionPayload(item: PriorVerdictItem): {
  readonly version: number;
  readonly callId: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly trace: readonly string[];
  readonly result: CallResult;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
  readonly configRevision: string;
  readonly ts: number;
} {
  return {
    version: DECISION_RECORD_VERSION,
    callId: item.callId,
    tool: item.tool,
    fingerprint: item.fingerprint,
    trace: item.trace,
    result: item.result,
    reason: item.reason ?? '',
    ruleId: item.ruleId ?? null,
    decisionRules: item.decisionRules ?? [],
    configRevision: item.configRevision,
    ts: item.ts,
  };
}

/**
 * Read one committed decision record.
 *
 * Every field a decision needs is required: a payload missing its result or
 * identity is not interpretable, and guessing one would manufacture history.
 * The time falls back to the record envelope's own time, which the host wrote
 * when it committed the event, so an old payload without `ts` still orders
 * correctly.
 */
/** Read one optional string field, or `undefined` when it is absent. */
function optionalText(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read one committed decision record.
 *
 * Every field a decision needs is required: a payload missing its result or
 * identity is not interpretable, and guessing one would manufacture history.
 * The time falls back to the record envelope's own time, which the host wrote
 * when it committed the event, so an old payload without `ts` still orders
 * correctly.
 */
/** The identity fields a decision record must carry, or `null`. */
function decisionIdentity(record: Record<string, unknown>): {
  readonly callId: string;
  readonly tool: string;
  readonly result: CallResult;
} | null {
  const result = asCallResult(record['result']);
  const tool = optionalText(record, 'tool');
  const callId = optionalText(record, 'callId');
  if (result === null || tool === undefined || tool.length === 0) return null;
  if (callId === undefined || callId.length === 0) return null;
  return { callId, tool, result };
}

/**
 * Read one committed decision record.
 *
 * Every field a decision needs is required: a payload missing its result or
 * identity is not interpretable, and guessing one would manufacture history.
 * The time falls back to the record envelope's own time, which the host wrote
 * when it committed the event, so an old payload without `ts` still orders
 * correctly.
 */
export function decodeDecisionRecord(
  data: unknown,
  envelope: { readonly time: number | undefined; readonly seq: number },
): DecisionRecord | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const record: Record<string, unknown> = { ...data };
  const identity = decisionIdentity(record);
  if (identity === null) return null;
  const ts = record['ts'];
  const decisionRules = stringList(record['decisionRules']);
  const reason = optionalText(record, 'reason');
  const ruleId = optionalText(record, 'ruleId');
  return {
    ...identity,
    ts: typeof ts === 'number' ? ts : (envelope.time ?? envelope.seq),
    configRevision: optionalText(record, 'configRevision') ?? 'unknown',
    fingerprint: optionalText(record, 'fingerprint') ?? '',
    trace: stringList(record['trace']) ?? [],
    // An empty reason is absent: an empty string would travel to the reviewer as
    // a stated reason for the decision.
    ...(reason === undefined || reason.length === 0 ? {} : { reason }),
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(decisionRules === null ? {} : { decisionRules }),
  };
}

/** The item shape a decoded record contributes to selection. */
export function priorItemOf(record: DecisionRecord): PriorVerdictItem {
  return {
    ts: record.ts,
    callId: record.callId,
    configRevision: record.configRevision,
    tool: record.tool,
    fingerprint: record.fingerprint,
    trace: record.trace,
    result: record.result,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.ruleId === undefined ? {} : { ruleId: record.ruleId }),
    ...(record.decisionRules === undefined
      ? {}
      : { decisionRules: record.decisionRules }),
  };
}
