/**
 * Stability, efficiency and comparability: three sections about how much the other
 * three layers can be trusted.
 *
 * All three answer the same question from a different angle — "how many independent
 * samples is this, and what did they cost?" — which is why they sit together after the
 * layers and before the evidence. Stability says how much of the cell count is
 * repetition; efficiency says what the cells cost in wall time and that nobody priced
 * them; comparability says which differences the run is entitled to attribute.
 *
 * The three tables print their unknowns with the same words the layers use, so a reader
 * moving between sections does not have to relearn them.
 */

import type { DifferenceRow, EvaluationReport } from '../metrics/types.js';
import { heading, num, pct, rateText, row, separator } from './format.js';

/** The stability and sample-weight section. */
export function stabilitySection(report: EvaluationReport): string {
  const stability = report.stability;
  const samples = stability.samples;
  return [
    heading(2, '重复稳定性与样本权重'),
    '',
    '相关变体与重复都不是独立样本：重复是同一个输入的第二次观测，只说明稳定性；变体与兄弟案例共享 seed，只说明机制覆盖。三者一起公开，因为任何一个单独出现都会误导——51 个格子可能是 51 个案例，也可能是一个案例重复了 51 次。',
    '',
    row(['项目', '值']),
    separator(2),
    row(['格子', String(samples.cells)]),
    row(['记录', String(samples.records)]),
    row(['**去重后的案例**', `**${String(samples.distinctCases)}**`]),
    row(['家族', String(samples.distinctFamilies)]),
    row(['目标', String(samples.distinctTargets)]),
    row(['协议', String(samples.distinctProtocols)]),
    row(['重复序号 > 1 的格子', String(samples.repeats)]),
    row(['修复重试 attempt（计入消耗，不是重复）', String(samples.repairs)]),
    '',
    ...(stability.repeatGroups.length === 0
      ? [
          '本次运行没有重复序号大于 1 的格子，因此没有稳定性样本；这不表示答案稳定，只表示没有重复观测。',
          '',
        ]
      : [
          `重复组：${String(stability.stableGroups)} 组稳定、${String(stability.unstableGroups)} 组不稳定、${String(stability.unassessableGroups)} 组无法判定，共覆盖 ${String(stability.withRepeats)} 个格子。`,
          '',
          row([
            '案例',
            'target',
            '协议',
            '重复数',
            '已判定',
            '稳定',
            '不同答案',
            'risk 极差',
            'authorization 极差',
          ]),
          separator(9),
          ...stability.repeatGroups.map((group) =>
            row([
              group.caseId,
              group.targetId,
              group.protocol,
              String(group.repeats),
              String(group.judged),
              group.stable === null ? '无法判定' : group.stable ? '是' : '否',
              String(group.distinctAnswers),
              num(group.riskSpread),
              num(group.authorizationSpread),
            ]),
          ),
          '',
        ]),
  ].join('\n');
}

/** One duration table. */
function durationTable(
  title: string,
  key: string,
  entries: EvaluationReport['efficiency']['byTarget'],
): string {
  return [
    heading(3, title),
    '',
    row([key, '格子', '总计 ms', '平均 ms', '中位 ms', '最大 ms']),
    separator(6),
    ...entries.map((entry) =>
      row([
        entry.key,
        String(entry.duration.cells),
        String(entry.duration.totalMs),
        num(entry.duration.meanMs),
        num(entry.duration.medianMs),
        num(entry.duration.maxMs),
      ]),
    ),
    '',
  ].join('\n');
}

/** The efficiency section. */
export function efficiencySection(report: EvaluationReport): string {
  const efficiency = report.efficiency;
  const duration = efficiency.duration;
  return [
    heading(2, '耗时与费用'),
    '',
    row(['项目', '值']),
    separator(2),
    row(['有记录格子', String(duration.cells)]),
    row(['总耗时 ms', String(duration.totalMs)]),
    row(['平均 ms', num(duration.meanMs)]),
    row(['中位 ms', num(duration.medianMs)]),
    row(['最大 ms', num(duration.maxMs)]),
    '',
    durationTable('按目标', 'target', efficiency.byTarget),
    durationTable('按协议', '协议', efficiency.byProtocol),
    heading(3, '费用'),
    '',
    `费用是状态，不是数字：本次运行 ${String(efficiency.cost.cells)} 个记录的 \`cost.amount\` 恒为 \`null\`（状态 ${efficiency.cost.status}）。报告不代币定价，**不输出任何费用合计**；把这些格子写成 0 会被读成「免费调用」，那是另一个事实。`,
    '',
    ...(efficiency.cost.reasons.length === 0
      ? []
      : efficiency.cost.reasons.map((reason) => `- ${reason}`)),
    '',
  ].join('\n');
}

/** The comparability section. */
export function comparisonSection(report: EvaluationReport): string {
  const comparison = report.comparison;
  return [
    heading(2, '可比性'),
    '',
    '同模型双协议只在目标确实同时支持两种协议时比较；模型与协议同时变化时只报告系统组合，不归因于单一协议。',
    '',
    heading(3, '同模型双协议比较'),
    '',
    ...(comparison.protocolComparisons.length === 0
      ? ['本次运行没有同模型双协议比较。', '']
      : [
          row([
            'target',
            'model',
            '依据',
            '案例',
            '配对',
            '行为一致',
            '配对一致率',
            '评分一致',
          ]),
          separator(8),
          ...comparison.protocolComparisons.map((entry) =>
            row([
              entry.targetId,
              entry.model,
              entry.basis,
              String(entry.cases),
              String(entry.paired),
              String(entry.behaviourAgree),
              rateText(entry.behaviourAgree, entry.paired),
              String(entry.scoreAgree),
            ]),
          ),
          '',
          ...comparison.protocolComparisons.flatMap((entry) =>
            entry.differences.length === 0
              ? []
              : [
                  row(['案例', 'chat 配对', 'decision 配对']),
                  separator(3),
                  ...entry.differences.map((difference) =>
                    row([
                      difference.caseId,
                      `${String(difference.chat[0])}/${String(difference.chat[1])}`,
                      `${String(difference.decision[0])}/${String(difference.decision[1])}`,
                    ]),
                  ),
                  '',
                ],
          ),
        ]),
    ...(comparison.systems.length === 0
      ? []
      : [
          heading(3, '系统组合（不作协议归因）'),
          '',
          row(['组合', 'model', '协议', '原因']),
          separator(4),
          ...comparison.systems.map((entry) =>
            row([
              entry.targetId,
              entry.model,
              entry.protocols.join(' ↔ '),
              entry.reason,
            ]),
          ),
          '',
        ]),
    ...(comparison.unsupported.length === 0
      ? []
      : [
          heading(3, '计划声明但不支持的组合'),
          '',
          ...comparison.unsupported.map(
            (entry) => `- ${entry.targetId}：${entry.reason}`,
          ),
          '',
        ]),
    ...(comparison.notes.length === 0
      ? []
      : [
          heading(3, '可比性说明'),
          '',
          ...comparison.notes.map((note) => `- ${note}`),
          '',
        ]),
  ].join('\n');
}

/** The differences section, grouped by kind. */
export function differencesSection(report: EvaluationReport): string {
  const differences = report.differences;
  if (differences.length === 0) {
    return [heading(2, '差异'), '', '本次运行没有可报告的差异。', ''].join(
      '\n',
    );
  }
  const kinds = new Map<string, DifferenceRow[]>();
  for (const difference of differences) {
    const existing = kinds.get(difference.kind);
    if (existing === undefined) kinds.set(difference.kind, [difference]);
    else existing.push(difference);
  }
  return [
    heading(2, '差异'),
    '',
    '行为差异与评分差异分开：判定正确但档位偏离是校准发现，不是质量失败，两者的修复方式不同。',
    '',
    ...[...kinds.entries()].flatMap(([kind, entries]) => [
      heading(3, `差异类型 ${kind}`),
      '',
      row(['cell', '案例', '观察', '期望', '说明']),
      separator(5),
      ...entries.map((entry) =>
        row([
          entry.cellId === '' ? '（数据集）' : entry.cellId,
          entry.caseId === '' ? '（数据集）' : entry.caseId,
          entry.observed,
          entry.expected,
          entry.detail,
        ]),
      ),
      '',
    ]),
  ].join('\n');
}

/** The per-example evidence table. */
export function examplesSection(report: EvaluationReport): string {
  return [
    heading(2, '逐例证据'),
    '',
    '每一行对应一个计划格子，包括从未运行的格子；把未运行的格子移出表格，会让一个小分母看起来像完整覆盖。输入指纹是标签审批所用的同一摘要，案例与标签路径相对数据集目录。引擎答案与人类参考分列，从不合并成一列。',
    '',
    row([
      'cell',
      '案例',
      '家族',
      '协议',
      '重复',
      '分类',
      '引擎',
      '参考',
      '结算',
      '输入指纹',
      '案例文件',
      '标签文件',
      '裁决理由',
    ]),
    separator(13),
    ...report.examples.map((example) =>
      row([
        example.cellId,
        example.caseId,
        example.familyId,
        example.protocol,
        `r${String(example.repeat)}`,
        example.classification,
        example.engine.word === null
          ? '（无判定）'
          : example.engine.risk === null
            ? example.engine.word
            : `${example.engine.word} ${String(example.engine.risk)}/${String(example.engine.authorization)}`,
        example.reference ?? '（无参考）',
        example.settlement,
        example.inputHash === '' ? '（无记录）' : example.inputHash,
        example.casePath ?? '（未读到）',
        example.labelPath ?? '（无标签）',
        example.rationale ?? '',
      ]),
    ),
    '',
    '逐例的完整原因——材料缺口、失败原因、通道说明——保存在同名的 JSON 摘要里，本表只索引它们。',
    '',
    `共 ${String(report.examples.length)} 行，其中 ${String(report.examples.filter((example) => example.classification === 'not-run').length)} 行从未派发。`,
    '',
    `当前模式下询问人工的格子占 ${pct(
      report.settlement.overall.askHuman === 0
        ? null
        : report.settlement.overall.askHuman / report.settlement.overall.cells,
    )}。`,
    '',
  ].join('\n');
}
