/**
 * Layer two's rendering: label coverage, score error, pairs, order and shape.
 *
 * The section opens with the label table rather than with a statistic, because every
 * figure below it is conditional on how many labels could count. A report that printed
 * a mean error before saying how many cases it covered would let a reader assume the
 * denominator was the dataset.
 */

import type {
  EvaluationReport,
  FieldErrorStats,
  LabelCoverage,
} from '../metrics/types.js';
import {
  fraction,
  heading,
  num,
  pct,
  rateText,
  row,
  separator,
} from './format.js';

/** The label coverage part of layer two. */
function labelSection(labels: LabelCoverage): string {
  const excluded = labels.rows.filter((entry) => entry.outcome === 'excluded');
  const absent = labels.rows.filter(
    (entry) => entry.outcome === 'missing' || entry.outcome === 'case-absent',
  );
  return [
    heading(3, '标签覆盖与分母'),
    '',
    row(['项目', '值']),
    separator(2),
    row(['标签来源', labels.source]),
    row(['数据集', labels.datasetId ?? '（无）']),
    row([
      '数据集版本',
      labels.versions === null
        ? '未知'
        : `${labels.versions.contract} / ${labels.versions.rubric} / ${labels.versions.policy}`,
    ]),
    row(['执行摘要', labels.executionDigest ?? '未知']),
    row(['观察到的案例', String(labels.cases)]),
    row(['**金标案例**', `**${String(labels.gold)}**`]),
    row(['被排除', String(labels.excluded)]),
    row(['缺标签', String(labels.missing)]),
    row([
      '**输入指纹不符（不用于比较）**',
      `**${String(labels.inputMismatch)}**`,
    ]),
    row([
      '**裁决冲突（不用于比较）**',
      `**${String(labels.authorityConflict)}**`,
    ]),
    row([
      'case 缺失（数据集未发布）',
      String(
        labels.rows.filter((entry) => entry.outcome === 'case-absent').length,
      ),
    ]),
    row(['pending', String(labels.pending)]),
    row(['disputed', String(labels.disputed)]),
    '',
    heading(4, '排除原因计数'),
    '',
    row(['原因', '数量']),
    separator(2),
    ...Object.entries(labels.excludedByReason).map(([reason, count]) =>
      row([reason, String(count)]),
    ),
    '',
    ...(excluded.length === 0
      ? []
      : [
          heading(4, '被排除的标签'),
          '',
          row(['案例', '状态', '原因', '裁决理由']),
          separator(4),
          ...excluded.map((entry) =>
            row([
              entry.caseId,
              entry.status ?? '（无）',
              entry.reasons.join('、') || '（无）',
              entry.rationale ?? '',
            ]),
          ),
          '',
        ]),
    ...(absent.length === 0
      ? []
      : [
          heading(4, '没有可计入金标标签的案例'),
          '',
          ...absent.map(
            (entry) =>
              `- ${entry.caseId}：${entry.outcome === 'case-absent' ? '数据集未发布该案例' : '数据集中没有标签文件'}`,
          ),
          '',
        ]),
  ].join('\n');
}

/** The two field tables, side by side, over one fixed list of rows. */
function fieldRows(
  risk: FieldErrorStats,
  authorization: FieldErrorStats,
): readonly string[] {
  const entries: readonly {
    readonly label: string;
    readonly value: (stats: FieldErrorStats) => string;
  }[] = [
    { label: '可比较案例', value: (stats) => String(stats.comparable) },
    { label: '完全一致', value: (stats) => String(stats.exact) },
    { label: '相邻一档', value: (stats) => String(stats.adjacent) },
    { label: '相差两档以上', value: (stats) => String(stats.far) },
    { label: '平均偏差（带符号）', value: (stats) => num(stats.meanSigned) },
    { label: '平均绝对偏差', value: (stats) => num(stats.meanAbsolute) },
    { label: '最大绝对偏差', value: (stats) => num(stats.maxAbsolute) },
  ];
  return entries.map((entry) =>
    row([entry.label, entry.value(risk), entry.value(authorization)]),
  );
}

/** The score-error and pair tables. */
function errorSection(report: EvaluationReport): string {
  const diagnostics = report.diagnostics;
  const pairs = diagnostics.pairs;
  return [
    heading(3, '评分误差与相邻档'),
    '',
    '只有裁决者把某个字段钉为唯一值的案例才进入该字段的分母；开放区间不是错误答案。相邻一档单列，因为它是校准问题；两档以上是另一个问题。',
    '',
    row(['指标', 'risk', 'authorization']),
    separator(3),
    ...fieldRows(diagnostics.risk, diagnostics.authorization),
    '',
    heading(3, '合法配对命中'),
    '',
    '配对命中与行为一致是两个问题：落在允许配对之外的配对仍可能恰好到达允许的行为，报告两者都列。',
    '',
    row(['指标', '值']),
    separator(2),
    row(['有可判定配对的案例', String(pairs.labeled)]),
    row(['落在允许配对内', String(pairs.exactPair)]),
    row(['配对命中率', rateText(pairs.exactPair, pairs.labeled)]),
    '',
    ...(pairs.outside.length === 0
      ? []
      : [
          row(['案例', '观察到的配对', '到最近允许配对的欧氏距离']),
          separator(3),
          ...pairs.outside.map((entry) =>
            row([
              entry.caseId,
              `${String(entry.observed[0])}/${String(entry.observed[1])}`,
              String(entry.distance),
            ]),
          ),
          '',
        ]),
  ].join('\n');
}

/** The monotonicity tables. */
function monotonicitySection(report: EvaluationReport): string {
  return [
    heading(3, '单调性'),
    '',
    '只比较参考严格排序的案例对；同分是十档量表允许的，因此单列为「同分」，不算反向单调。',
    '',
    row(['字段', '可比较对', '反向', '同分', '反向率']),
    separator(5),
    ...report.diagnostics.monotonicity.map((entry) =>
      row([
        entry.field,
        String(entry.comparablePairs),
        String(entry.reversals),
        String(entry.ties),
        rateText(entry.reversals, entry.comparablePairs),
      ]),
    ),
    '',
    ...report.diagnostics.monotonicity.flatMap((entry) =>
      entry.violations.length === 0
        ? []
        : [
            row(['字段', '参考更高', '参考更低', '参考对', '观察对']),
            separator(5),
            ...entry.violations.map((violation) =>
              row([
                entry.field,
                violation.higher,
                violation.lower,
                `${String(violation.reference[0])}/${String(violation.reference[1])}`,
                `${String(violation.observed[0])}/${String(violation.observed[1])}`,
              ]),
            ),
            '',
          ],
    ),
  ].join('\n');
}

/** The distribution tables. */
function shapeSection(report: EvaluationReport): string {
  return [
    heading(3, '分布形态'),
    '',
    '分布集中度是诊断，不是真实风险概率。均值只说明答案落在量表的哪个位置。',
    '',
    row([
      '字段',
      '观察案例',
      '参考案例',
      '众数',
      '众数占比',
      '不同取值',
      '均值',
    ]),
    separator(7),
    ...report.diagnostics.shape.map((entry) =>
      row([
        entry.field,
        String(entry.observedCells),
        String(entry.referenceCells),
        num(entry.mode),
        pct(entry.modeShare),
        String(entry.distinct),
        num(entry.mean),
      ]),
    ),
    '',
    ...report.diagnostics.shape.flatMap((entry) => [
      heading(4, `${entry.field} 分布`),
      '',
      row(['档位', '观察', '参考']),
      separator(3),
      ...Object.keys(entry.observed).map((level) =>
        row([
          level,
          String(entry.observed[level] ?? 0),
          entry.reference === null
            ? 'n/a'
            : String(entry.reference[level] ?? 0),
        ]),
      ),
      '',
    ]),
  ].join('\n');
}

/** Layer two. */
export function diagnosticsSection(report: EvaluationReport): string {
  const gold = report.diagnostics.labels.gold;
  return [
    heading(2, '第二层：R/A 诊断'),
    '',
    '这一层只解释第一层的判定，不参与判定。两个字段分别测量、从不合并成一个「评分质量」数字：偏差方向决定修复方式，单一数字会把方向抹掉。',
    '',
    ...(gold === 0
      ? [
          '**当前没有金标标签**，因此本层所有比值都没有分母，显示为 n/a。这是等待用户裁决的正常中间状态，不是 0% 通过率。',
          '',
        ]
      : []),
    labelSection(report.diagnostics.labels),
    errorSection(report),
    monotonicitySection(report),
    shapeSection(report),
  ].join('\n');
}

/** The fraction helper is re-exported so callers do not reach into format.js directly. */
export { fraction };
