/**
 * Assembling one derived run from a source run and a variant.
 *
 * The derived directory has the same shape as the run it came from — a plan, an
 * index and one immutable record per cell — because that is what makes it readable
 * by the report layer without a second reader. A replay therefore produces
 * *another run document*, not a side-table of "what would have happened": the
 * report that comes out of it is built by the same code that builds the original
 * one, and every figure in it can be traced back through the lineage.
 *
 * Three things are deliberately identical to the source and one is deliberately
 * not:
 *
 *   identical   the plan, the dataset revision and the fixture digest, because
 *               the replay re-reads the same evidence rather than a new
 *               experiment
 *   identical   the records' attempts, usage, timings and material, because a
 *               replay spends nothing and must not appear to have
 *   identical   the index's timestamps, which is what makes two replays of one
 *               variant byte-identical
 *   different   the index's run id and implementation, because the derived
 *               document was produced by the replayer from saved answers. A
 *               report whose run id equalled its source's would claim to be the
 *               same run with different numbers.
 *
 * Every cell is accounted for exactly once: a re-derived cell carries its new
 * outcome, and a cell the variant cannot touch carries the stored one with the
 * reason recorded beside it. A replay that dropped the cells it could not read
 * would report a smaller, cleaner experiment than the one it was asked about.
 */

import { cellIdOf, recordPathOf } from '../run/artifact.js';
import type { CellRecord, CellState, RunIndex, RunPlan } from '../run/types.js';
import { RUN_INDEX_VERSION } from '../run/types.js';

import { replayCell } from './derive.js';
import type { CellReplay } from './derive.js';
import type { SourceRead } from './source.js';
import type {
  ReplayCellLineage,
  ReplayLineage,
  ReplaySource,
  ReplayTotals,
  ReplayVariant,
} from './types.js';
import {
  REPLAY_IMPLEMENTATION_VERSION,
  REPLAY_LINEAGE_VERSION,
} from './types.js';

/** One source directory that was read successfully. */
export type ReadableSource = Extract<SourceRead, { readonly ok: true }>;

/** The derived run directory, as documents rather than files. */
export interface DerivedRun {
  readonly runId: string;
  readonly plan: RunPlan;
  readonly index: RunIndex;
  readonly records: readonly CellRecord[];
  /** Records keyed by cell id, so a writer need not re-walk the list. */
  readonly byCell: ReadonlyMap<string, CellRecord>;
  /**
   * The scripted socket the source replayed, copied verbatim.
   *
   * The derived index repeats the source's `fixtureDigest`, so the document that
   * digest describes belongs beside it; a derived directory whose plan named a
   * fixture it did not carry would be a run a reader could not verify.
   */
  readonly fixture: Buffer | null;
}

/** Everything one variant produced, before anything is written. */
export interface Derivation {
  readonly variant: ReplayVariant;
  readonly run: DerivedRun;
  readonly lineage: ReplayLineage;
}

/**
 * The run id a derived directory reports.
 *
 * The variant's own label is readable but can be long, and a run id is a slug with
 * a bounded length. The suffix is kept whole — it ends in the variant's digest, so
 * two variants never collapse into one id — and only the source's prefix is
 * shortened when the budget runs out. A reader who needs the whole axis list reads
 * the lineage, which always carries it.
 */
export function replayRunIdOf(sourceRunId: string, variantId: string): string {
  const suffix = `-replay-${variantId}`;
  const room = 63 - suffix.length;
  if (room < 1) return `replay-${variantId.slice(-8)}`;
  const trimmed =
    sourceRunId.length > room ? sourceRunId.slice(0, room) : sourceRunId;
  return `${trimmed}${suffix}`;
}

/** The totals of one derivation, computed from the lineage rows themselves. */
function totalsOf(rows: readonly ReplayCellLineage[]): ReplayTotals {
  const count = (disposition: ReplayCellLineage['disposition']): number =>
    rows.filter((row) => row.disposition === disposition).length;
  return {
    cells: rows.length,
    reDerived: count('re-derived'),
    kept: count('kept'),
    notReplayable: count('not-replayable'),
    noRecord: count('no-record'),
    changed: rows.filter((row) => row.changed).length,
  };
}

/**
 * The notes a derived lineage carries about the derivation itself.
 *
 * These are the statements a reader would otherwise have to reconstruct: which
 * contract produced the new bands, whether it matches the one the source recorded,
 * and what masking cost. They are facts, so they are stated rather than implied.
 */
function notesOf(parts: {
  readonly source: ReplaySource;
  readonly runningContract: string;
  readonly totals: ReplayTotals;
  readonly variant: ReplayVariant;
}): readonly string[] {
  const notes: string[] = [
    '这次派生只读源运行目录：没有发出任何请求，没有解析凭据，没有改写源记录；派生产物写在另一个目录。',
    '重新归一化与判定调用的是与生产同一份 `src/review-contract/`（`bandFrom`、`scoreReview`）与同一份适配器解析器；本目录不复制任何判定逻辑。',
  ];
  if (parts.source.versions.contract !== parts.runningContract) {
    notes.push(
      `源运行记录的契约版本是 ${parts.source.versions.contract}，本次重算运行在 ${parts.runningContract} 下：派生结果描述的是「旧答案按当前规则读取」，不是原运行的回放一致性证明。`,
    );
  }
  if (parts.variant.answer === 'response-text') {
    notes.push(
      '读的是记录里保存的响应原文。该原文在适配器写出记录前已按已知凭据遮蔽；遮蔽可能改变文本（例如 decision 的 `authorization` 分数对象被当成 header），无法解析的格子标为不可回放而不是修补。',
    );
  } else {
    notes.push(
      '读的是适配器自己的解析结果 `parsed`，不是响应原文；它绕开了原文遮蔽可能造成的不可读，但也因此不验证原文本身。',
    );
  }
  if (parts.totals.notReplayable > 0) {
    notes.push(
      `${String(parts.totals.notReplayable)} 个格子的答案无法从保存的材料重建，已保留原判定并在逐格清单里写明原因；它们不参与派生比较。`,
    );
  }
  if (parts.totals.kept > 0) {
    notes.push(
      `${String(parts.totals.kept)} 个格子保留原判定：技术故障、材料不足或该轴对它们不适用时，任何阈值都不会改变结论。`,
    );
  }
  notes.push(
    '参考标签没有因为这次派生而改变：`labels/` 只被读取，派生报告按原标签比较引擎答案。',
  );
  return notes;
}

/** The versions a derived run records. */
function derivedVersions(parts: {
  readonly source: ReplaySource;
  readonly runningContract: string;
}): RunIndex['versions'] {
  return {
    // The bands were selected by the running contract, so that is the version that
    // explains them; the source's own value is preserved in the lineage.
    contract: parts.runningContract,
    prompt: parts.source.versions.prompt,
    usageMapping: parts.source.versions.usageMapping,
    plan: parts.source.versions.plan,
    artifact: parts.source.versions.artifact,
    implementation: REPLAY_IMPLEMENTATION_VERSION,
    node: parts.source.versions.node ?? process.version,
  };
}

/** One record as the derived run stores it. */
function derivedRecord(parts: {
  readonly record: CellRecord;
  readonly runId: string;
  readonly versions: RunIndex['versions'];
}): CellRecord {
  const { node: _node, ...withoutNode } = parts.versions;
  return {
    ...parts.record,
    runId: parts.runId,
    // A record inherits its run's versions and omits the runtime: the node version
    // is a property of the run, not of the cell.
    versions: withoutNode,
  };
}

/** One index cell, with the derived record's status standing in for the source's. */
function derivedCellState(
  state: CellState,
  record: CellRecord | null,
): CellState {
  if (record === null) return state;
  return {
    ...state,
    status: record.status,
    attempts: record.attempts.filter((attempt) => attempt.sent !== false)
      .length,
    stopReason: record.stopReason,
  };
}

/**
 * Derive one run.
 *
 * Pure with respect to the filesystem: every input is already read and every
 * output is a document. The writer is what turns this into a directory, which is
 * what lets a test assert on the derivation without a temporary directory.
 */
export function deriveRun(parts: {
  readonly source: ReadableSource;
  readonly variant: ReplayVariant;
  readonly runningContract: string;
  readonly derivedDirectory: string;
  /** The variants document's version, when the caller supplied one. */
  readonly variantsDocument: string | null;
}): Derivation {
  const replays: CellReplay[] = [];
  for (const state of parts.source.index.cells) {
    const sourced = parts.source.records.get(state.cellId) ?? null;
    replays.push(
      sourced === null
        ? missingCellReplay(state)
        : replayCell({
            record: sourced.record,
            variant: parts.variant,
            sourceFile: { path: sourced.path, digest: sourced.digest },
          }),
    );
  }
  const runId = replayRunIdOf(
    parts.source.index.runId,
    parts.variant.variantId,
  );
  const versions = derivedVersions({
    source: parts.source.source,
    runningContract: parts.runningContract,
  });
  const records = replays.flatMap((entry) =>
    entry.record === null
      ? []
      : [
          derivedRecord({
            record: entry.record,
            runId,
            versions,
          }),
        ],
  );
  const byCell = new Map(records.map((record) => [record.cellId, record]));
  const cells = parts.source.index.cells.map((state) =>
    derivedCellState(state, byCell.get(state.cellId) ?? null),
  );
  const totals = totalsOf(replays.map((entry) => entry.lineage));
  const index: RunIndex = {
    ...parts.source.index,
    documentVersion: RUN_INDEX_VERSION,
    runId,
    plan: parts.source.plan,
    versions,
    cells,
    // Every figure in this block describes the source's dispatch, which the replay
    // did not repeat. Copying it unchanged is what states "nothing new was spent".
    spent: parts.source.index.spent,
    notes: [
      ...parts.source.index.notes,
      `派生自运行 ${parts.source.index.runId} 的 ${String(parts.source.index.cells.length)} 个已保存答案，由 ${parts.variant.variantId} 离线重算；没有新增请求。`,
      `第三层按 ${parts.variant.settlement.mode}/${parts.variant.settlement.channel} 结算；重建报告时用 --mode ${parts.variant.settlement.mode} --channel ${parts.variant.settlement.channel} 复现。`,
    ],
  };
  return {
    variant: parts.variant,
    run: {
      runId,
      plan: parts.source.plan,
      index,
      records,
      byCell,
      fixture: parts.source.fixture,
    },
    lineage: {
      documentVersion: REPLAY_LINEAGE_VERSION,
      replay: {
        implementation: REPLAY_IMPLEMENTATION_VERSION,
        variantId: parts.variant.variantId,
        digest: parts.variant.digest,
        answer: parts.variant.answer,
        thresholds: parts.variant.thresholds,
        settlement: parts.variant.settlement,
        description: parts.variant.description,
        matrix: 'shared',
        contract: parts.runningContract,
        variantsDocument: parts.variantsDocument,
      },
      source: parts.source.source,
      derived: {
        directory: parts.derivedDirectory,
        runId,
        report: [],
      },
      totals,
      cells: replays.map((entry) => entry.lineage),
      notes: notesOf({
        source: parts.source.source,
        runningContract: parts.runningContract,
        totals,
        variant: parts.variant,
      }),
    },
  };
}

/**
 * The lineage row for a planned cell the source run never wrote.
 *
 * A cell decided before dispatch has no answer to re-read, so it is carried through
 * unchanged. It is not an error: the index distinguishes a pre-dispatch refusal
 * from a gap, and the replay must not turn one into the other.
 */
function missingCellReplay(state: CellState): CellReplay {
  return {
    lineage: {
      cellId: state.cellId,
      caseId: state.caseId,
      targetId: state.targetId,
      protocol: state.protocol,
      repeat: state.repeat,
      disposition: 'no-record',
      reason: `the source run holds no record for this cell (index status ${state.status}); there is no saved answer to re-read`,
      attemptId: null,
      responseDigest: null,
      record: null,
      stored: null,
      derived: null,
      changed: false,
    },
    // The cell has no record here either: a pre-dispatch decision carries no answer.
    record: null,
    reDerived: false,
  };
}

/** The path a derived record occupies, straight from its identity. */
export function pathOfDerivedRecord(record: CellRecord): string {
  return recordPathOf(
    cellIdOf({
      caseId: record.case.caseId,
      targetId: record.target.targetId,
      protocol: record.target.protocol,
      repeat: record.execution.repeat,
    }),
  );
}
