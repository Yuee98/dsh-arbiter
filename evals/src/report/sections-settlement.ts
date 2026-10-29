/**
 * Layer three's rendering: the actual mode and the settlement the host performs.
 *
 * The section opens with whether the figures are observed or projected, because that
 * distinction decides what a reader may conclude. A projection says the reviewer
 * escalates; only an observation says a person was actually asked.
 *
 * The question counts are broken into necessary, unnecessary and unknown rather than
 * into one "human" total. Asking a person is the cost this milestone is about, so the
 * table has to distinguish a question the reference wanted from one it did not, and
 * from one nobody can judge yet.
 */

import type {
  EvaluationReport,
  SettlementCounts,
  SettlementGroup,
} from '../metrics/types.js';
import { humanCostOf } from '../metrics/settlement.js';
import { heading, pct, rateText, row, separator } from './format.js';

/** The settlement counts, as rows. */
function settlementRows(counts: SettlementCounts): readonly string[] {
  const cost = humanCostOf(counts);
  const classified = cost.necessary + cost.unnecessary + cost.unknown;
  return [
    row(['格子', String(counts.cells)]),
    row(['allow', String(counts.allow)]),
    row(['deny', String(counts.deny)]),
    row(['归一为拒绝（无通道／no-ask）', String(counts.fallbackDeny)]),
    row(['询问人工', String(counts.askHuman)]),
    row(['未审查（无判定可结算）', String(counts.notReviewed)]),
    row(['其中来自技术故障的询问', String(counts.technical.askHuman)]),
    row(['其中来自技术故障的归一拒绝', String(counts.technical.fallbackDeny)]),
    row(['其中来自技术故障的未审查', String(counts.technical.notReviewed)]),
    row(['不必要的人工（参考已放行／拒绝）', String(cost.unnecessary)]),
    row(['必要的人工（参考要求升级）', String(cost.necessary)]),
    row(['必要性未知（无金标）', String(cost.unknown)]),
    row([
      '不必要人工占已分类提问',
      `${pct(cost.unnecessaryShare)} (${String(cost.unnecessary)}/${String(classified)})`,
    ]),
  ];
}

/** The grouped settlement tables, one per axis. */
function groupedTables(groups: readonly SettlementGroup[]): string {
  const axes = new Map<string, SettlementGroup[]>();
  for (const group of groups) {
    const existing = axes.get(group.axis);
    if (existing === undefined) axes.set(group.axis, [group]);
    else existing.push(group);
  }
  return [...axes.entries()]
    .flatMap(([axis, entries]) => [
      heading(3, `按 ${axis} 分组`),
      '',
      row([
        '分组',
        '格子',
        'allow',
        'deny',
        '归一拒绝',
        '询问人工',
        '不必要人工',
        '未审查',
      ]),
      separator(8),
      ...entries.map((entry) =>
        row([
          entry.title,
          String(entry.counts.cells),
          String(entry.counts.allow),
          String(entry.counts.deny),
          String(entry.counts.fallbackDeny),
          String(entry.counts.askHuman),
          String(entry.counts.unnecessaryHuman),
          String(entry.counts.notReviewed),
        ]),
      ),
      '',
    ])
    .join('\n');
}

/** Layer three. */
export function settlementSection(report: EvaluationReport): string {
  const settlement = report.settlement;
  return [
    heading(2, '第三层：实际模式、人工与宿主结算'),
    '',
    settlement.projection
      ? '本次运行没有任何格子经过宿主链，因此这一层是**按共享 settle() 规则推演的结果**，不是宿主观察到的行为。'
      : '本次运行包含宿主链格子，这一层反映宿主实际结算。',
    '',
    row(['项目', '值']),
    separator(2),
    row(['ask 模式', settlement.mode]),
    row(['人工通道', settlement.channel]),
    row(['计数口径', settlement.projection ? '推演' : '实际']),
    '',
    row(['结算', '数量']),
    separator(2),
    ...settlementRows(settlement.overall),
    '',
    '`归一为拒绝` 与 `deny` 分开：前者是「本应问人但没有通道」，后者是审查结论本身。混成一个数字会把可用性问题读成质量结论。',
    '',
    groupedTables(settlement.byGroup),
  ].join('\n');
}

/** The settlement figure a single population needs beside it, for the CLI's summary. */
export function humanCostLine(counts: SettlementCounts): string {
  const cost = humanCostOf(counts);
  return `询问人工 ${String(cost.asked)}（不必要 ${String(cost.unnecessary)}、必要 ${String(cost.necessary)}、未知 ${String(cost.unknown)}）`;
}

/** The rate text one settlement population needs, for a caller printing one line. */
export function settlementRateText(counts: SettlementCounts): string {
  return rateText(counts.unnecessaryHuman, counts.askHuman);
}
