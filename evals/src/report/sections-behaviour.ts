/**
 * Layer one's rendering: the behaviour counts, overall and grouped.
 *
 * The table prints the denominator next to every rate and the class counts beside them,
 * because the class table is the part a reader acts on. A single agreement rate would
 * let a run look acceptable while one family systematically allows what should be
 * denied, and the grouped tables are where that becomes visible.
 */

import type {
  BehaviourCounts,
  BehaviourGroup,
  EvaluationReport,
} from '../metrics/types.js';
import type { BehaviourClass } from '../metrics/types.js';
import { fraction, heading, pct, rateText, row, separator } from './format.js';

/** The class-by-class row labels, in print order. */
const CLASS_LABELS: readonly {
  readonly key: BehaviourClass;
  readonly label: string;
}[] = [
  { key: 'false-allow', label: '误放（引擎放行，参考拒绝／升级）' },
  { key: 'false-deny', label: '误拒（引擎拒绝，参考放行或升级）' },
  { key: 'unnecessary-human', label: '不必要人工（参考已放行）' },
  { key: 'escalate-not-deny', label: '升级而非拒绝（参考拒绝）' },
  { key: 'material-unavailable-but-scored', label: '材料不足却给出判定' },
  { key: 'failure-expected-but-not-reported', label: '参考为故障却给出判定' },
  { key: 'undecided', label: '引擎拒答而参考可判' },
  { key: 'matched', label: '一致' },
  { key: 'technical', label: '技术失败（不当作拒绝）' },
  { key: 'missing-record', label: '缺记录' },
  { key: 'not-run', label: '派发前已决定' },
  { key: 'uncompared', label: '无参考可比' },
];

/** One population's counts, as rows of a two-column table body. */
export function countRows(counts: BehaviourCounts): readonly string[] {
  return [
    row(['格子', String(counts.cells)]),
    row(['已判定', String(counts.judged)]),
    row(['有金标参考', String(counts.referenceKnown)]),
    row(['**参与比较的分母**', `**${String(counts.compared)}**`]),
    ...CLASS_LABELS.map((entry) =>
      row([entry.label, String(counts.byClass[entry.key])]),
    ),
    row(['误放率', rateText(counts.falseAllow, counts.compared)]),
    row(['误拒率', rateText(counts.falseDeny, counts.compared)]),
    row(['不必要人工率', rateText(counts.unnecessaryHuman, counts.compared)]),
    row([
      '错误率',
      rateText(counts.compared - counts.matched, counts.compared),
    ]),
    row(['一致率', rateText(counts.matched, counts.compared)]),
    row([
      `按案例加权的一致率（${String(counts.caseBalanced.cases)} 个可比较案例）`,
      pct(counts.caseBalanced.agreementRate),
    ]),
    row(['按案例加权的误放率', pct(counts.caseBalanced.falseAllowRate)]),
    row(['按案例加权的误拒率', pct(counts.caseBalanced.falseDenyRate)]),
    row([
      '按案例加权的不必要人工率',
      pct(counts.caseBalanced.unnecessaryHumanRate),
    ]),
  ];
}

/** The grouped tables, one per axis, in print order. */
function groupedTables(groups: readonly BehaviourGroup[]): string {
  const axes = new Map<string, BehaviourGroup[]>();
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
        '分母',
        '一致',
        '误放',
        '误拒',
        '不必要人工',
        '技术失败',
        '无参考／未运行',
        '一致率',
        '按案例加权一致率',
      ]),
      separator(11),
      ...entries.map((entry) =>
        row([
          entry.title,
          String(entry.counts.cells),
          String(entry.counts.compared),
          String(entry.counts.matched),
          String(entry.counts.falseAllow),
          String(entry.counts.falseDeny),
          String(entry.counts.unnecessaryHuman),
          String(entry.counts.technical + entry.counts.missingRecord),
          String(entry.counts.uncompared + entry.counts.notRun),
          `${pct(entry.counts.agreementRate)} (${fraction(entry.counts.matched, entry.counts.compared)})`,
          pct(entry.counts.caseBalanced.agreementRate),
        ]),
      ),
      '',
    ])
    .join('\n');
}

/** Layer one. */
export function behaviourSection(report: EvaluationReport): string {
  return [
    heading(2, '第一层：主要自动行为指标'),
    '',
    '分母只包含「引擎给出了对本次调用的判定」且「案例有可计入金标的参考」的格子。技术失败、缺记录与派发前已决定的格子都在分母之外，各自单独列出：把技术失败算成拒绝，会让一个坏掉的传输读起来像一个谨慎的审查者。',
    '',
    row(['指标', '值']),
    separator(2),
    ...countRows(report.behaviour.overall),
    '',
    heading(2, '分组（第一层）'),
    '',
    '同一张表同时给出按格子与按案例加权的比率：相关变体与重复共享 seed，不是独立样本，按案例加权给出「每个案例一票」的口径。',
    '',
    groupedTables(report.behaviour.byGroup),
  ].join('\n');
}
