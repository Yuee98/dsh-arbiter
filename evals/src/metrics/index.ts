/**
 * Assembling one run directory into the three-layer report.
 *
 * This is the module a caller invokes, and it does exactly two things: read a saved run
 * (and optionally its dataset), then fold the result into the document the renderers
 * print. It imports no executor, opens no socket and reads no clock — the report's
 * provenance comes from the run index's own `createdAt` and from the records' own
 * timings, so a document rebuilt from one artifact is byte-identical to the one built
 * the day the run finished.
 *
 * The three layers are built in a fixed order and each one reads the same cell list, so
 * a reader can move from a behaviour figure to the score that produced it to the
 * settlement the host would perform, and find the same cells at every step.
 */

import type { AskPolicy } from '../../../src/review-contract/index.js';
import { cellFactsOfRun } from './cell.js';
import type { CellFacts } from './cell.js';
import { behaviourSection } from './behaviour.js';
import { comparisonSection } from './comparison.js';
import {
  fieldErrorStats,
  monotonicityStats,
  pairStats,
  shapeStats,
} from './diagnostics.js';
import { efficiencySection } from './efficiency.js';
import { labelFindingsOf } from './evidence.js';
import type { CellView, DifferenceRow } from './types.js';
import { emptyGoldNote, labelCoverageOf } from './labels.js';
import { observeRun } from './observe.js';
import type { Observation, ObservationRead } from './observe.js';
import { isProjection, settlementSection } from './settlement.js';
import { stabilitySection } from './stability.js';
import { usageSection } from './usage.js';
import { cellViewsOf, differencesOf } from './evidence.js';
import { compareText, distinct, tally } from './support.js';
import type {
  CoverageSummary,
  DatasetSource,
  DiagnosticsSection,
  EvaluationReport,
  ReportCheck,
  RunIdentity,
  ReportSettings,
} from './types.js';
import { REPORT_FORMAT_VERSION } from './types.js';
import { RECORDLESS_STATUSES } from '../run/artifact.js';
import type { RunArtifact } from '../run/artifact.js';

/** What the report needs to know about the run's own identity. */
function runIdentityOf(
  artifact: RunArtifact,
  records: readonly {
    readonly entryPoint: { readonly kind: string };
  }[],
): RunIdentity {
  const index = artifact.index;
  return {
    runId: index.runId,
    status: index.status,
    createdAt: index.createdAt,
    updatedAt: index.updatedAt,
    planHash: index.planHash,
    datasetId: index.dataset.datasetId,
    datasetDigest: index.dataset.digest,
    datasetCaseCount: index.dataset.caseCount,
    transport: index.transport,
    repeats: index.plan.repeats,
    protocols: [...index.plan.protocols],
    targets: index.plan.targets.map((target) => ({
      targetId: target.targetId,
      provider: target.provider,
      model: target.model,
      modelVersion: target.modelVersion,
      protocols: (['chat', 'decision'] as const).filter((protocol) =>
        protocol === 'chat' ? target.chat !== null : target.decision !== null,
      ),
    })),
    versions: {
      contract: index.versions.contract,
      prompt: index.versions.prompt,
      usageMapping: index.versions.usageMapping,
      plan: index.versions.plan,
      artifact: index.versions.artifact,
      implementation: index.versions.implementation,
      node: index.versions.node ?? null,
    },
    entryPoints: distinct(records.map((record) => record.entryPoint.kind)),
  };
}

/**
 * What the run planned, recorded and failed to record.
 *
 * `planned` and `records` are separate numbers rather than one, because the difference
 * between them is the point: a run that planned sixty-four cells and wrote twelve is
 * an interrupted run, and reporting only "twelve cells" would describe it as small
 * rather than as incomplete.
 */
function coverageOf(
  observation: Observation,
  cells: readonly CellFacts[],
): CoverageSummary {
  const artifact = observation.artifact;
  const attempts = cells.reduce(
    (total, cell) => total + (cell.record?.attempts.length ?? 0),
    0,
  );
  const sentAttempts = cells.reduce(
    (total, cell) =>
      total +
      (cell.record?.attempts.filter((attempt) => attempt.sent !== false)
        .length ?? 0),
    0,
  );
  const reserved = cells.reduce(
    (total, cell) => total + (cell.record?.abandonment?.reservedAttempts ?? 0),
    0,
  );
  return {
    cellsPlanned: artifact.index.cells.length,
    records: artifact.records.length,
    missing: artifact.missing,
    statuses: tally(artifact.index.cells.map((cell) => cell.status)),
    attempts,
    sentAttempts,
    reservedAttempts: reserved,
    observedCases: distinct(cells.map((cell) => cell.caseId)).length,
    observedFamilies: distinct(
      cells.map((cell) => cell.caseFacts?.familyId ?? 'unknown'),
    ).length,
  };
}

/**
 * The claims the report verifies about its own inputs.
 *
 * These are not a pass or fail gate. A report that refused to render because a run was
 * interrupted would be useless exactly when it is most needed, so the checks are
 * published as facts beside the numbers and a reader decides what they mean. Two of
 * them are load-bearing for the report's honesty: that no record names a cell the index
 * did not plan, and that re-aggregating each record's attempts reproduced its stored
 * usage summary.
 */
function checksOf(parts: {
  readonly observation: Observation;
  readonly cells: readonly CellFacts[];
  readonly usageReproduced: boolean;
  readonly recordCount: number;
}): readonly ReportCheck[] {
  const artifact = parts.observation.artifact;
  const statuses = new Set(artifact.index.cells.map((cell) => cell.status));
  const dispatched = [...statuses].filter(
    (status) => !RECORDLESS_STATUSES.has(status),
  );
  const missing = artifact.missing.length;
  return [
    {
      name: 'no-stray-records',
      ok: parts.observation.strays.length === 0,
      detail:
        parts.observation.strays.length === 0
          ? '每个记录都对应索引计划过的格子。'
          : `有记录不属于索引计划的格子：${parts.observation.strays.join(', ')}`,
    },
    {
      name: 'dispatched-cells-have-records',
      ok: missing === 0,
      detail:
        missing === 0
          ? `所有已派发状态（${dispatched.join('、') || '无'}）都有对应记录。`
          : `${String(missing)} 个声称已派发的格子没有记录，这是真正的缺口而不是中间状态。`,
    },
    {
      name: 'usage-reproduced-from-attempts',
      ok: parts.usageReproduced,
      detail: parts.usageReproduced
        ? '逐格用共享 aggregateUsage 重算每个记录的 attempt，结果与记录自带的汇总一致。'
        : '至少一个记录自带的 usage 汇总无法由其 attempt 重算得到，报告仍按重算值输出。',
    },
    {
      name: 'records-read',
      ok: parts.recordCount > 0 || artifact.index.cells.length === 0,
      detail: `索引计划 ${String(artifact.index.cells.length)} 个格子，读取到 ${String(parts.recordCount)} 条记录。`,
    },
  ];
}

/**
 * The diagnostics layer.
 *
 * The label coverage is built here rather than passed in because every figure in this
 * layer needs it: a field error without a denominator is not a number, and the coverage
 * is what supplies one.
 */
function diagnosticsOf(parts: {
  readonly cells: readonly CellFacts[];
  readonly observation: Observation;
}): DiagnosticsSection {
  const labels = labelCoverageOf({
    cells: parts.cells,
    dataset: parts.observation.dataset,
    executionDigest: parts.observation.artifact.index.dataset.digest,
  });
  return {
    labels,
    risk: fieldErrorStats(parts.cells, 'risk'),
    authorization: fieldErrorStats(parts.cells, 'authorization'),
    pairs: pairStats(parts.cells),
    monotonicity: [
      monotonicityStats(parts.cells, 'risk'),
      monotonicityStats(parts.cells, 'authorization'),
    ],
    shape: [
      shapeStats(parts.cells, 'risk'),
      shapeStats(parts.cells, 'authorization'),
    ],
  };
}

/** The notes a report carries about its own denominators. */
function notesOf(parts: {
  readonly cells: readonly CellFacts[];
  readonly observation: Observation;
  readonly diagnostics: DiagnosticsSection;
  readonly views: readonly CellView[];
}): readonly string[] {
  const notes: string[] = [];
  const gold = emptyGoldNote(parts.diagnostics.labels);
  if (gold.length > 0) notes.push(gold);
  const repeats = parts.cells.filter((cell) => cell.repeat > 1).length;
  if (repeats > 0) {
    notes.push(
      `${String(repeats)} 个格子是独立重复；它们与相关变体都不作为独立样本，按案例加权的比率已在每张表旁列出。`,
    );
  }
  const noRecord = parts.cells.filter(
    (cell) => cell.standing === 'not-run',
  ).length;
  if (noRecord > 0) {
    notes.push(
      `${String(noRecord)} 个格子在派发前就已决定（不支持、预算耗尽或未开始），不计入任何比较分母。`,
    );
  }
  const technical = parts.cells.filter(
    (cell) => cell.standing === 'no-outcome',
  ).length;
  if (technical > 0) {
    notes.push(
      `${String(technical)} 个格子已派发但没有产出可判定结果；这类技术结果单独计数，不当成拒绝。`,
    );
  }
  for (const problem of parts.observation.problems) notes.push(problem);
  for (const finding of parts.observation.dataset.findings) {
    notes.push(`数据集：${finding}`);
  }
  const moved = parts.cells.filter(
    (cell) => cell.caseFacts?.conflictsWithDataset === true,
  );
  if (moved.length > 0) {
    const cases = [...new Set(moved.map((cell) => cell.caseId))].sort(
      compareText,
    );
    notes.push(
      `${String(cases.length)} 个案例在数据集中的家族、split 或来源已与运行记录不同（${cases.join('、')}）；分组以运行记录为准，差异在此列出。`,
    );
  }
  const projection = isProjection(parts.cells);
  if (projection) {
    notes.push(
      '没有格子经过宿主链，因此第三层是按共享结算规则推演的结果，不是宿主实际观察到的行为。',
    );
  }
  return notes;
}

/** The differences, combining the per-cell ones with the dataset's own open items. */
function differencesFor(parts: {
  readonly cells: readonly CellFacts[];
  readonly observation: Observation;
}): readonly DifferenceRow[] {
  return [
    ...differencesOf(parts.cells),
    ...labelFindingsOf({
      cells: parts.cells,
      datasetNotes: parts.observation.dataset.problems,
    }),
  ].sort(
    (left, right) =>
      compareText(left.kind, right.kind) ||
      compareText(left.caseId, right.caseId) ||
      compareText(left.cellId, right.cellId) ||
      compareText(left.detail, right.detail),
  );
}

/**
 * Build the report from one observation.
 *
 * Pure: the same observation produces the same document, and the settings only choose
 * how layer three is computed and whether labels were joined. Nothing here writes a
 * file; the renderers and the writer do that.
 */
export function buildReport(parts: {
  readonly observation: Observation;
  readonly settings: ReportSettings;
}): EvaluationReport {
  const cells = cellFactsOfRun(parts.observation);
  const diagnostics = diagnosticsOf({ cells, observation: parts.observation });
  const views = cellViewsOf({
    cells,
    mode: parts.settings.mode,
    channel: parts.settings.channel,
  });
  const usage = usageSection(cells);
  const settlement = settlementSection({
    cells,
    mode: parts.settings.mode,
    channel: parts.settings.channel,
    projection: isProjection(cells),
  });
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    run: runIdentityOf(
      parts.observation.artifact,
      parts.observation.artifact.records,
    ),
    setup: {
      mode: parts.settings.mode,
      channel: parts.settings.channel,
      labels: parts.observation.dataset.status,
      settlementProjection: settlement.projection,
    },
    coverage: coverageOf(parts.observation, cells),
    behaviour: behaviourSection(cells),
    diagnostics,
    settlement,
    usage,
    stability: stabilitySection(cells),
    efficiency: efficiencySection(cells),
    comparison: comparisonSection(cells),
    examples: views,
    differences: differencesFor({ cells, observation: parts.observation }),
    checks: checksOf({
      observation: parts.observation,
      cells,
      usageReproduced: usage.byCell.every((cell) => cell.matchesRecord),
      recordCount: parts.observation.records.size,
    }),
    notes: notesOf({
      cells,
      observation: parts.observation,
      diagnostics,
      views,
    }),
  };
}

/** A report, or the problems that stopped one being built. */
export type ReportBuild =
  | { readonly ok: true; readonly report: EvaluationReport }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Read a run directory and build its report.
 *
 * The two steps stay separate functions because a caller that already holds an
 * observation — a comparison over several runs, a replay that re-derives one — should
 * not have to read the directory twice to get a second report from it.
 */
export async function reportForRun(parts: {
  readonly directory: string;
  readonly settings: ReportSettings;
}): Promise<ReportBuild> {
  const read: ObservationRead = await observeRun({
    directory: parts.directory,
    root: parts.settings.root,
    dataset: parts.settings.dataset,
  });
  if (!read.ok) return { ok: false, problems: read.problems };
  return {
    ok: true,
    report: buildReport({
      observation: read.observation,
      settings: parts.settings,
    }),
  };
}

/**
 * The default settings a report is built with when a caller names none.
 *
 * The dataset is `recorded`, not `none`: a report's default is the dataset the run itself
 * executed, which is what makes a rebuild reproducible on another machine. Asking for no
 * dataset is a separate, explicit choice.
 */
export function defaultSettings(root: string): ReportSettings {
  return {
    mode: 'ask',
    channel: 'available',
    dataset: { kind: 'recorded' },
    root,
  };
}

/** A dataset source from a caller's own string, where an empty value means "the run's own". */
export function datasetSourceOf(path: string | null): DatasetSource {
  return path === null ? { kind: 'recorded' } : { kind: 'path', path };
}

/** A parse of the two settlement flags, refused rather than defaulted when wrong. */
export function parseSettlementMode(value: string): AskPolicy | null {
  return value === 'ask' || value === 'no-ask' ? value : null;
}
