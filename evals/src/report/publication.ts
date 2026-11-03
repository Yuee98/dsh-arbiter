/** Publication facts augment the shared report without changing its metric population. */
import { join, resolve } from 'node:path';
import type { Observation } from '../metrics/observe.js';
import { datasetPathOf } from '../metrics/observe.js';
import type { EvaluationReport, ReportSettings } from '../metrics/types.js';
import { RECORDLESS_STATUSES } from '../run/artifact.js';
import { canonicalJson } from '../data/hash.js';
import { reportEvidence } from './evidence.js';
import type { GitObservation } from '../run/workflow-types.js';
import type {
  PublishedReport,
  ReportPublication,
} from './publication-types.js';

function unknown(reason: string): GitObservation {
  return { root: null, revision: null, dirty: null, reason };
}

export function publishReport(parts: {
  readonly report: EvaluationReport;
  readonly observation: Observation;
  readonly directory: string;
  readonly settings: ReportSettings;
}): PublishedReport {
  const { artifact } = parts.observation;
  const records = new Map(
    artifact.records.map((record) => [record.cellId, record]),
  );
  const cells = artifact.index.cells.map((state) => {
    const record = records.get(state.cellId);
    const reason =
      record === undefined
        ? RECORDLESS_STATUSES.has(state.status)
          ? null
          : 'required-record-missing'
        : state.status === record.status
          ? null
          : 'index-record-status-disagreement';
    return {
      cellId: state.cellId,
      indexStatus: state.status,
      recordStatus: record?.status ?? null,
      recordPresent: record !== undefined,
      recordPath:
        record === undefined ? null : join(parts.directory, state.record),
      mismatch: reason !== null,
      reason,
    };
  });
  const workflow = artifact.index.workflowExecution;
  const publicWorkflow = parts.report.run.workflowExecution;
  const dataset = datasetPathOf(parts.settings.dataset, artifact);
  const legacy = artifact.index.provenance;
  const conflict =
    workflow !== undefined &&
    legacy !== undefined &&
    canonicalJson(workflow.codeGit) !== canonicalJson(legacy.codeGit);
  const reliable = !conflict && !cells.some((cell) => cell.mismatch);
  const publication: ReportPublication = {
    generation: 'rendered',
    qualityAcceptance: {
      status: 'not-assessed',
      reason: '未配置正式验收门槛；生成报告和工程自检均不表示模型质量通过。',
    },
    testedCode:
      publicWorkflow?.codeGit ??
      legacy?.codeGit ??
      unknown('原运行未记录被测 Git；不使用报告生成时 HEAD 回填。'),
    testedSource:
      publicWorkflow?.sourceGit ??
      unknown('原运行未记录独立数据源 Git；数据范围与摘要见原运行。'),
    archiveCommit: 'tracked-by-git-history',
    runDirectory: parts.directory,
    evidenceAccess: 'local-only',
    planPath: join(parts.directory, 'plan.json'),
    indexPath: join(parts.directory, 'index.json'),
    datasetPath:
      dataset === null ? null : resolve(parts.settings.root, dataset),
    references: (parts.settings.references ?? []).map((path) =>
      resolve(parts.settings.root, path),
    ),
    scope: {
      split: artifact.plan.split,
      plannedCells: cells.length,
      groups: [
        ...new Set(
          parts.report.examples.map((cell) =>
            cell.source?.kind === 'workflow' ? cell.source.group : 'legacy-v1',
          ),
        ),
      ].sort(),
    },
    context: {
      maxInputTokens:
        publicWorkflow?.config.context.maxInputTokens ??
        artifact.plan.context.maxInputTokens,
      targetInputTokens:
        publicWorkflow?.config.context.targetInputTokens ??
        artifact.plan.context.targetInputTokens ??
        null,
    },
    consistency: {
      indexReliable: reliable,
      provenanceConflict: conflict,
      cells,
    },
  };
  return {
    ...parts.report,
    publication,
    evidence: reportEvidence(parts.report, parts.observation),
    checks: [
      ...parts.report.checks,
      {
        name: 'index-record-consistency',
        ok: reliable,
        detail: reliable
          ? '索引状态与已保存记录一致。'
          : '索引未完成更新或来源互相矛盾；逐格并列原索引与持久化记录，完成状态分布未经核实。',
      },
    ],
  };
}
