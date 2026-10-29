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
  InputStanding,
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
  readonly runningPrompt: string;
  readonly totals: ReplayTotals;
  readonly variant: ReplayVariant;
  readonly inputs: InputStanding;
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
  // The prompt is not replayed. Its version says which instructions produced the
  // answers, and a replay can only re-read answers a prompt already produced — so a
  // changed prompt is stated as requiring another request, not as a variation this
  // derivation measured. Without this the lineage would record the drift and let a
  // reader mistake the derivation for evidence about the new prompt.
  if (parts.source.versions.prompt !== parts.runningPrompt) {
    notes.push(
      `源运行记录的 prompt 版本是 ${parts.source.versions.prompt}，当前生产是 ${parts.runningPrompt}：prompt 不属于回放的轴，派生结果描述的是「旧 prompt 的答案按当前规则读取」。要测量新 prompt 必须重新发起请求；本目录不能替代那次评测。`,
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
  notes.push(inputNote(parts.inputs, parts.source.dataset));
  return notes;
}

/**
 * What the lineage says about the material the answers were produced from.
 *
 * This is the note a later reader needs most, because it is the only part of the
 * derivation that cannot be recovered from the files: whether the saved answers still
 * speak about the dataset as it is. It names the affected cases, so "which evidence is
 * stale" is answerable without re-running the comparison.
 */
function inputNote(
  standing: InputStanding,
  dataset: ReplaySource['dataset'],
): string {
  const provenance = `源运行针对的数据集是 ${dataset.datasetId}（${dataset.digest}）。回放只重读保存的响应，所以数据集变化不会改变派生分数。`;
  if (standing.status === 'undetermined') {
    return `${provenance}本次无法判定当前数据集的输入是否仍与保存时一致（${standing.reason}）：这是「未验证」，不是「未变化」。要测量当前材料必须重新发起请求。`;
  }
  if (standing.drifted.length === 0 && standing.unverified.length === 0) {
    return `${provenance}已逐例比对：本次运行涉及的每个案例，当前输入 hash 与保存时一致，保存的答案仍是关于当前材料的证据。`;
  }
  const parts: string[] = [provenance];
  if (standing.drifted.length > 0) {
    parts.push(
      `以下案例的输入在运行之后改变（${standing.drifted
        .map((entry) => `${entry.caseId}: ${entry.recorded} → ${entry.current}`)
        .join(
          '；',
        )}）：保存的答案产生于旧材料，不能再用来评价当前输入，要测量必须重新发起请求。`,
    );
  }
  if (standing.unverified.length > 0) {
    parts.push(
      `以下案例的当前输入无法确认（${standing.unverified
        .map((entry) => `${entry.caseId}: ${entry.reason}`)
        .join('；')}）：它们既不算变化也不算一致，属于未验证。`,
    );
  }
  return parts.join('');
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
  /** The prompt version this build ships, so a drift from the source can be stated. */
  readonly runningPrompt: string;
  /** How the saved evidence stands against the dataset, as the command found it. */
  readonly inputs: InputStanding;
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
      inputs: parts.inputs,
      notes: notesOf({
        source: parts.source.source,
        runningContract: parts.runningContract,
        runningPrompt: parts.runningPrompt,
        totals,
        variant: parts.variant,
        inputs: parts.inputs,
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
