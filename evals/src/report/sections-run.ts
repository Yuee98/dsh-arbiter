/**
 * The report's opening sections: what ran, and what it covered.
 *
 * Everything a reader needs to decide whether the later numbers mean anything is here —
 * the run's identity, the versions it ran under, the settings the report was built with,
 * and the difference between what was planned and what was recorded. A report that
 * opened with a rate would invite the reader past all of it.
 */

import type { EvaluationReport } from '../metrics/types.js';
import { heading, row, separator } from './format.js';

/** The run's identity and the settings the report was built under. */
export function identitySection(report: EvaluationReport): string {
  const run = report.run;
  return [
    heading(2, '运行身份'),
    '',
    row(['项目', '值']),
    separator(2),
    row(['run', `\`${run.runId}\``]),
    row(['状态', run.status]),
    row(['创建于', run.createdAt]),
    row(['最后更新', run.updatedAt]),
    row(['plan 哈希', `\`${run.planHash}\``]),
    row(['数据集', `${run.datasetId} \`${run.datasetDigest}\``]),
    row(['数据集案例数', String(run.datasetCaseCount)]),
    row(['传输', run.transport]),
    row(['协议', run.protocols.join('、')]),
    row(['重复次数', String(run.repeats)]),
    row(['入口链', run.entryPoints.join('、') || '（无记录）']),
    '',
    heading(3, '版本'),
    '',
    row(['版本项', '值']),
    separator(2),
    row(['contract', run.versions.contract]),
    row(['prompt', run.versions.prompt]),
    row(['usage mapping', run.versions.usageMapping]),
    row(['plan', run.versions.plan]),
    row(['artifact', run.versions.artifact]),
    row(['implementation', run.versions.implementation]),
    row(['node', run.versions.node ?? '未知']),
    '',
    heading(3, '目标'),
    '',
    row(['target', 'provider/model', 'model 版本', '计划支持的协议']),
    separator(4),
    ...run.targets.map((target) =>
      row([
        target.targetId,
        `${target.provider}/${target.model}`,
        target.modelVersion ?? '未知',
        target.protocols.join('、') || '（无）',
      ]),
    ),
    '',
    heading(3, '报告设置'),
    '',
    row(['项目', '值']),
    separator(2),
    row(['ask 模式', report.setup.mode]),
    row(['人工通道', report.setup.channel]),
    row(['标签来源', report.setup.labels]),
    row([
      '第三层口径',
      report.setup.settlementProjection
        ? '推演（无宿主链单元格）'
        : '宿主实际结算',
    ]),
    '',
  ].join('\n');
}

/** What was planned, what was recorded, and what is missing. */
export function coverageSection(report: EvaluationReport): string {
  const coverage = report.coverage;
  return [
    heading(2, '覆盖与分母'),
    '',
    '分母在这里公开。缺少记录的格子和派发前已决定的格子都不进入任何比率；前者是真正的缺口，后者是运行器的正常状态。',
    '',
    row(['指标', '值']),
    separator(2),
    row(['计划格子', String(coverage.cellsPlanned)]),
    row(['记录数', String(coverage.records)]),
    row(['**宣称已派发但缺记录**', `**${String(coverage.missing.length)}**`]),
    row(['attempt 总数', String(coverage.attempts)]),
    row(['已发送 attempt', String(coverage.sentAttempts)]),
    row(['未报告的预留 attempt', String(coverage.reservedAttempts)]),
    row(['观察到的案例', String(coverage.observedCases)]),
    row(['观察到的家族', String(coverage.observedFamilies)]),
    '',
    heading(3, '格子状态分布'),
    '',
    row(['状态', '数量']),
    separator(2),
    ...Object.entries(coverage.statuses).map(([status, count]) =>
      row([status, String(count)]),
    ),
    '',
    ...(coverage.missing.length === 0
      ? []
      : [
          heading(3, '声称跑过却没有记录的格子'),
          '',
          ...coverage.missing.map(
            (cell) =>
              `- \`${cell.cellId}\`：索引状态 ${cell.status}，记录文件 \`${cell.record}\` 不存在。`,
          ),
          '',
        ]),
  ].join('\n');
}

/** The self-checks and the notes a reader must not skip. */
export function closingSection(report: EvaluationReport): string {
  return [
    heading(2, '自检'),
    '',
    '这些不是通过／失败门槛：运行被中断时报告仍然有用，所以自检结果作为事实公开，由读者决定它的含义。',
    '',
    row(['检查', '结果', '说明']),
    separator(3),
    ...report.checks.map((check) =>
      row([check.name, check.ok ? '通过' : '**未通过**', check.detail]),
    ),
    '',
    heading(2, '说明'),
    '',
    ...(report.notes.length === 0
      ? ['无额外说明。']
      : report.notes.map((note) => `- ${note}`)),
    '',
  ].join('\n');
}
