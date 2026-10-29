/**
 * The usage extension: per attempt, per review, and per model, protocol and run.
 *
 * Every figure here is produced by the *shared* aggregate (`aggregateUsage` from the
 * production usage contract) over attempts the record already kept. Nothing in this
 * module maps a provider field, defines a bucket, or adds two numbers together: the
 * mapping version, the six buckets and the sub-count inclusions are the ones a run
 * was normalized under, and this report re-reads them rather than restating them.
 *
 * Three distinctions survive from the artifact on purpose, because each one is a
 * place where a cheaper report would lie:
 *
 *   - unknown is not zero. A bucket a provider never reported stays `null` and its
 *     coverage says how many attempts reported it. A total over four of five attempts
 *     is published with `complete: false`, never as the whole.
 *   - a sub-count is not added to its parent. Cache reads and reasoning tokens carry
 *     their declared inclusion (`contained`, `separate`, `unknown`) and are never
 *     summed into input or output, so a reader who adds them knows they are choosing
 *     to.
 *   - a repair and a repeat are different things. Both are real attempts and both are
 *     counted; only the repeat is a second observation, so the stability section is
 *     the only place a repeat appears.
 *
 * The re-aggregation also serves as a self-check: a record stores its own summary, and
 * recomputing it from the same attempts must reproduce it. `matchesRecord` reports
 * that, and a mismatch is a defect in the artifact rather than a surprising total.
 */

import { aggregateUsage } from '../../../src/reviewer/usage.js';
import type {
  UsageAggregate,
  UsageAttempt,
  UsageField,
} from '../../../src/reviewer/usage.js';

import { usageAttemptsOf } from '../run/artifact.js';
import type { CellRecord } from '../run/types.js';

import type { CellFacts } from './cell.js';
import { compareText, groupBy, sumReported } from './support.js';
import type {
  AttemptUsageRow,
  CellUsage,
  UsageScope,
  UsageSection,
} from './types.js';

/** The six buckets, in the order the contract lists them. */
const FIELDS: readonly UsageField[] = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
];

/**
 * One record's attempts as the shared aggregate takes them.
 *
 * `usageAttemptsOf` is the published helper for exactly this: it keeps the population
 * the record's own summary covers — the requests that were actually sent — so a
 * re-aggregation cannot disagree with the stored figure by counting a pre-send
 * refusal that no provider ever saw.
 */
function attemptsOf(record: CellRecord): readonly UsageAttempt[] {
  return usageAttemptsOf(record);
}

/** One attempt's row, with the tokens it reported kept per bucket. */
function attemptRow(
  cell: CellFacts,
  attempt: CellRecord['attempts'][number],
): AttemptUsageRow {
  const usage = attempt.normalizedUsage;
  const tokens = (field: UsageField): number | null =>
    usage === null ? null : usage.tokens[field];
  return {
    cellId: cell.cellId,
    caseId: cell.caseId,
    targetId: cell.targetId,
    protocol: cell.protocol,
    repeat: cell.repeat,
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attempt,
    // A repair is the transport's own second ask, not an independent observation, so
    // it is labelled here rather than inferred from the attempt number later.
    kind: attempt.kind,
    sent: attempt.sent !== false,
    durationMs: attempt.durationMs,
    estimatedInputTokens: attempt.estimatedInputTokens,
    tokens: {
      inputTokens: tokens('inputTokens'),
      outputTokens: tokens('outputTokens'),
      totalTokens: tokens('totalTokens'),
      cacheReadTokens: tokens('cacheReadTokens'),
      cacheWriteTokens: tokens('cacheWriteTokens'),
      reasoningTokens: tokens('reasoningTokens'),
    },
    mappingVersion: usage?.mappingVersion ?? null,
    source: usage?.source ?? null,
    ignored: usage?.ignored ?? [],
  };
}

/**
 * Whether two aggregates describe the same figures.
 *
 * Compared field by field on the totals and their coverage, not on the whole object:
 * the stored summary and a re-derivation are produced by the same function, so any
 * difference is a real one and a deep equality would also flag a harmless member
 * addition in a future version.
 */
function sameAggregate(
  left: UsageAggregate | null,
  right: UsageAggregate | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.attempts !== right.attempts) return false;
  if (left.withUsage !== right.withUsage) return false;
  for (const field of FIELDS) {
    const a = left.totals[field];
    const b = right.totals[field];
    if (a.total !== b.total) return false;
    if (a.reported !== b.reported || a.missing !== b.missing) return false;
  }
  return true;
}

/** Aggregate one subset of cells, or null when none of them ran a sent attempt. */
function scopeOf(key: string, cells: readonly CellFacts[]): UsageScope {
  const attempts = cells.flatMap((cell) =>
    cell.record === null ? [] : attemptsOf(cell.record),
  );
  return {
    key,
    cells: cells.length,
    // An empty population has no aggregate at all: an aggregate over zero attempts
    // would report `attempts: 0` and six null totals, which reads like a measured
    // "nothing was spent" rather than "this subset ran nothing".
    aggregate: attempts.length === 0 ? null : aggregateUsage(attempts),
  };
}

/** One group's scope, sorted by key. */
function scopesOf(
  cells: readonly CellFacts[],
  keyOf: (cell: CellFacts) => string,
): readonly UsageScope[] {
  return [...groupBy(cells, keyOf).entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, group]) => scopeOf(key, group));
}

/**
 * The run's usage.
 *
 * The whole-run aggregate is computed over every record's sent attempts, in cell-id
 * order so two rebuilds of one artifact sum in the same order and produce the same
 * bits. Float addition is not associative, and a total that depended on iteration
 * order would make a byte-identical rebuild impossible.
 */
export function usageSection(cells: readonly CellFacts[]): UsageSection {
  const ordered = [...cells].sort((left, right) =>
    compareText(left.cellId, right.cellId),
  );
  const attempts: AttemptUsageRow[] = [];
  const byCell: CellUsage[] = [];
  const allAttempts: UsageAttempt[] = [];
  let estimatedInput: number | null = null;
  let estimatedAttempts = 0;
  let estimatedCells = 0;
  let reservations = 0;
  for (const cell of ordered) {
    const record = cell.record;
    if (record === null) {
      byCell.push({
        cellId: cell.cellId,
        caseId: cell.caseId,
        targetId: cell.targetId,
        protocol: cell.protocol,
        repeat: cell.repeat,
        status: cell.indexStatus,
        aggregate: null,
        // A cell with no record has nothing to reproduce, so the cross-check does not
        // apply. Saying `true` would claim a comparison that never happened.
        matchesRecord: true,
      });
      continue;
    }
    for (const attempt of record.attempts) {
      attempts.push(attemptRow(cell, attempt));
    }
    const cellAttempts = attemptsOf(record);
    allAttempts.push(...cellAttempts);
    byCell.push({
      cellId: cell.cellId,
      caseId: cell.caseId,
      targetId: cell.targetId,
      protocol: cell.protocol,
      repeat: cell.repeat,
      status: record.status,
      aggregate: record.usage,
      matchesRecord: sameAggregate(
        record.usage,
        cellAttempts.length === 0 ? null : aggregateUsage(cellAttempts),
      ),
    });
    // The adapter's own estimate, kept apart from what the provider reported. It is a
    // different quantity: an estimate covers the request that was built, and the
    // provider's count covers what the provider decided to bill.
    const estimate = record.material?.estimatedInputTokens ?? null;
    if (estimate !== null) {
      estimatedInput = (estimatedInput ?? 0) + estimate;
      estimatedCells += 1;
    }
    for (const attempt of record.attempts) {
      if (attempt.sent === false) continue;
      estimatedAttempts += 1;
    }
    // A cell abandoned while its request was outstanding may have spent attempts the
    // record never reported. They are counted as a separate line because charging them
    // into a token total would invent numbers, while omitting them would imply the run
    // spent nothing on them.
    reservations += record.abandonment?.reservedAttempts ?? 0;
  }
  return {
    mappingVersion: aggregateUsage(allAttempts).mappingVersion,
    attempts,
    run: allAttempts.length === 0 ? null : aggregateUsage(allAttempts),
    byCell,
    byModel: scopesOf(ordered, (cell) => cell.modelKey),
    byProtocol: scopesOf(ordered, (cell) => cell.protocol),
    byTarget: scopesOf(ordered, (cell) => cell.targetId),
    estimated: {
      inputTokens: estimatedInput,
      attempts: estimatedAttempts,
      cells: estimatedCells,
    },
    unreportedReservations: reservations,
    notes: usageNotes(ordered, attempts),
  };
}

/**
 * The remarks a totals table needs beside it.
 *
 * Each one names a way the numbers could be misread if the table were taken alone.
 * They are generated rather than hand-written so a run with no unknown bucket does
 * not carry a warning about unknowns it does not have.
 */
function usageNotes(
  cells: readonly CellFacts[],
  attempts: readonly AttemptUsageRow[],
): readonly string[] {
  const notes: string[] = [];
  const withoutUsage = attempts.filter(
    (attempt) => attempt.mappingVersion === null,
  ).length;
  if (withoutUsage > 0) {
    notes.push(
      `${String(withoutUsage)} 个已发送 attempt 没有任何用量载荷，因此六个桶都记为未知而不是 0。`,
    );
  }
  const sent = attempts.filter((attempt) => attempt.sent).length;
  if (attempts.length > sent) {
    notes.push(
      `${String(attempts.length - sent)} 个 attempt 未被发送（输入超出上限被拒），不计入用量覆盖。`,
    );
  }
  const repairs = attempts.filter(
    (attempt) => attempt.kind === 'repair',
  ).length;
  if (repairs > 0) {
    notes.push(
      `${String(repairs)} 个 attempt 是传输自身的格式修复重试，计入消耗但不是独立重复样本。`,
    );
  }
  const cache = sumReported(
    attempts.map((attempt) => attempt.tokens.cacheReadTokens),
  );
  if (cache !== null) {
    notes.push(
      '缓存读取与写入、reasoning 子项保持独立桶并按声明的包含关系标注，不并入 input/output。',
    );
  }
  const reservations = cells.reduce(
    (total, cell) => total + (cell.record?.abandonment?.reservedAttempts ?? 0),
    0,
  );
  if (reservations > 0) {
    notes.push(
      `有 ${String(reservations)} 个预留在超时或取消时未能报告，可能已被计费；报告不为它们编造 token 数。`,
    );
  }
  return notes;
}
