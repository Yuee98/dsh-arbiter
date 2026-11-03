/** Both human formats render the same comparison tables; no artifact is read here. */
import type { EvaluationReport } from '../metrics/types.js';
import type {
  ComparisonSide,
  ComparisonTransitions,
} from '../metrics/version-comparison-types.js';
import { heading, pct, row, separator } from './format.js';
import { escape } from './html-format.js';

interface ComparisonTable {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}
function sideRows(
  side: ComparisonSide,
  name: string,
): readonly (readonly string[])[] {
  return side.cells.map((cell) => [
    name,
    cell.cellId,
    JSON.stringify(cell.source),
    cell.targetId,
    cell.protocol,
    String(cell.repeat),
    cell.indexStatus,
    cell.standing,
    cell.model === null
      ? 'unknown'
      : [
          cell.model.provider,
          cell.model.configured,
          `reported=${cell.model.reported ?? 'unknown'}`,
          `version=${cell.model.version ?? 'unknown'}`,
        ].join(' / '),
    JSON.stringify(cell.settings),
    cell.inputHash ?? 'unknown',
    cell.promptFingerprint ?? 'unknown',
    String(cell.targetInputTokens ?? 'unknown'),
    String(cell.maxInputTokens ?? 'unknown'),
    cell.original.classification,
    cell.original.reference ?? 'unknown',
    cell.original.pairHit === null ? 'n/a' : String(cell.original.pairHit),
    cell.common.classification,
    cell.common.reference ?? 'unknown',
    cell.common.source,
    cell.common.referenceId ?? 'unknown',
    cell.common.pairHit === null ? 'n/a' : String(cell.common.pairHit),
    String(cell.common.risk ?? 'unknown'),
    String(cell.common.authorization ?? 'unknown'),
  ]);
}
function metricRow(
  name: string,
  metric: ComparisonTransitions,
): readonly string[] {
  return [
    name,
    String(metric.paired),
    `${String(metric.baselineMatched)}/${String(metric.paired)} (${pct(metric.baselineRate)})`,
    `${String(metric.currentMatched)}/${String(metric.paired)} (${pct(metric.currentRate)})`,
    String(metric.improved),
    String(metric.regressed),
    String(metric.unchanged),
  ];
}
function tablesOf(report: EvaluationReport): readonly ComparisonTable[] {
  const section = report.versionComparison;
  if (section === undefined) return [];
  return [
    {
      title: '运行、完整覆盖与参考输入',
      columns: [
        '侧',
        '运行',
        '计划 cells',
        '计划条件',
        '状态',
        '原参考输入',
        '共同参考输入',
        '原参考匹配/分母',
        '共同参考匹配/分母',
      ],
      rows: [section.baseline, section.current].map((side, index) => [
        index === 0 ? 'baseline' : 'current',
        side.run.runId,
        String(side.cellsPlanned),
        String(side.conditionsPlanned),
        JSON.stringify(side.statuses),
        [side.datasetInput ?? 'none', ...side.referenceInputs].join(', '),
        [side.commonDatasetInput ?? 'none', ...side.commonReferenceInputs].join(
          ', ',
        ),
        `${String(side.original.matched)}/${String(side.original.compared)}`,
        `${String(side.common.matched)}/${String(side.common.compared)}`,
      ]),
    },
    {
      title: '实际运行条件',
      columns: ['侧', '候选', '策略与重算', '版本', '配置'],
      rows: [section.baseline, section.current].map((side, index) => [
        index === 0 ? 'baseline' : 'current',
        JSON.stringify(side.run.candidate ?? null),
        JSON.stringify(side.conditions),
        JSON.stringify(side.run.versions),
        JSON.stringify(side.run.workflowExecution ?? null),
      ]),
    },
    {
      title: `共同集合：${String(section.pairedConditions)}/${String(section.unionConditions)} 条件，${String(section.pairedPoints)} 点/视图`,
      columns: [
        '指标',
        '共同分母',
        '基线匹配',
        '当前匹配',
        '提升',
        '回退',
        '未变',
      ],
      rows: [
        metricRow('行为', section.behaviour),
        metricRow('R/A 组合', section.scoring),
      ],
    },
    {
      title: '逐条件迁移与不可比原因',
      columns: [
        '条件',
        '基线 cell',
        '当前 cell',
        '行为迁移',
        '评分迁移',
        '不可比原因',
        '实际条件差异',
      ],
      rows: section.rows.map((entry) => [
        entry.key,
        entry.baselineCellId ?? 'none',
        entry.currentCellId ?? 'none',
        entry.behaviourChange?.outcome ?? 'n/a',
        entry.scoringChange?.outcome ?? 'n/a',
        entry.reasons.join(', '),
        entry.conditionChanges.join(', '),
      ]),
    },
    {
      title: '两侧全部计划 cells（含所有 repeats）',
      columns: [
        '侧',
        'cell',
        '来源',
        '目标',
        '协议',
        'repeat',
        '状态',
        '记录',
        '实际模型',
        '模型参数',
        '输入 hash',
        '原始 prompt hash',
        '目标预算',
        '硬预算',
        '原分类',
        '原参考',
        '原评分命中',
        '共同分类',
        '共同参考',
        '共同参考来源',
        '共同参考 ID',
        '共同评分命中',
        'R',
        'A',
      ],
      rows: [
        ...sideRows(section.baseline, 'baseline'),
        ...sideRows(section.current, 'current'),
      ],
    },
    {
      title: '两侧自检',
      columns: ['侧', '检查', '通过', '详情'],
      rows: [section.baseline, section.current].flatMap((side, index) =>
        side.checks.map((check) => [
          index === 0 ? 'baseline' : 'current',
          check.name,
          String(check.ok),
          check.detail,
        ]),
      ),
    },
  ];
}
const EXPLANATION =
  '最低计划 repeat 构成主统计；全部 cells 保留在覆盖表。共同新参考分别验证两侧已保存响应，不新增模型请求。历史参考无法仅凭保存运行确认，原参考指本次显式提供的报告时输入。两侧总准确率不相减；不同模型、prompt、预算或策略属于系统观测，不能归因于单一变量。模型具体版本未返回时保持未知。';
export function versionComparisonSection(
  report: EvaluationReport,
  format: 'markdown' | 'html',
): string {
  if (report.versionComparison === undefined) return '';
  const tables = tablesOf(report);
  if (format === 'markdown')
    return [
      heading(2, '跨版本比较'),
      '',
      EXPLANATION,
      '',
      ...tables.map((table) =>
        [
          heading(3, table.title),
          '',
          row(table.columns),
          separator(table.columns.length),
          ...table.rows.map(row),
          '',
        ].join('\n'),
      ),
    ].join('\n');
  return `<section id="version-comparison"><h2>跨版本比较</h2><p>${escape(EXPLANATION)}</p>${tables
    .map(
      (table) =>
        `<h3>${escape(table.title)}</h3><div class="report-table" tabindex="0" aria-label="${escape(table.title)}"><table><caption>${escape(table.title)}</caption><thead><tr>${table.columns.map((value) => `<th scope="col">${escape(value)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((values) => `<tr>${values.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
    )
    .join('')}</section>`;
}
