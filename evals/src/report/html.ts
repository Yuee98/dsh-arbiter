/**
 * The HTML rendering of a report.
 *
 * The HTML variant exists for reading away from a terminal: it is the same document as
 * the Markdown, with the same figures and the same warnings, presented so the three
 * layers can be compared side by side. It is deliberately one self-contained file with
 * no script and no external stylesheet, because a report gets archived, mailed and
 * opened from a path that may not have network access — and because a report that ran
 * code would be a much larger security surface than a document needs.
 *
 * Every piece of text that came from the artifact is escaped. Case ids, model names,
 * adjudication rationales and provider reasons are user-supplied strings; a rationale
 * containing an angle bracket must not become markup. The escaping is applied in one
 * helper and every interpolation goes through it, which is the only way to keep that
 * true as sections are added.
 */

import type { UsageAggregate } from '../../../src/reviewer/usage.js';
import type {
  AttemptUsageRow,
  BehaviourCounts,
  BehaviourGroup,
  CellView,
  DifferenceRow,
  EvaluationReport,
  FieldErrorStats,
  LabelCoverage,
  SettlementCounts,
  SettlementGroup,
  UsageScope,
} from '../metrics/types.js';
import type { BehaviourClass } from '../metrics/types.js';
import { humanCostOf } from '../metrics/settlement.js';
import { fraction, num, pct, rateText } from './format.js';

/** Escape one value for HTML text or an attribute. */
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A heading element. */
function h(level: number, text: string): string {
  return `<h${String(level)}>${escape(text)}</h${String(level)}>`;
}

/** A paragraph of prose. */
function p(text: string): string {
  return `<p>${escape(text)}</p>`;
}

/** One table row from already-safe cells. */
function tr(cells: readonly string[], header = false): string {
  const tag = header ? 'th' : 'td';
  return `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`;
}

/**
 * A table from a caption, a header row and body rows.
 *
 * The caption is emitted as a real `<caption>` so a screen reader announces which table
 * a figure belongs to; the tables here are long and similar, and a bare `<table>` would
 * make them indistinguishable out of context.
 */
function table(
  caption: string,
  header: readonly string[],
  body: readonly (readonly string[])[],
): string {
  return [
    '<table>',
    `<caption>${escape(caption)}</caption>`,
    `<thead>${tr(header.map(escape), true)}</thead>`,
    `<tbody>${body.map((row) => tr(row)).join('')}</tbody>`,
    '</table>',
  ].join('');
}

/** A two-column key/value table. */
function pairs(
  caption: string,
  rows: readonly (readonly [string, string])[],
): string {
  return table(
    caption,
    ['项目', '值'],
    rows.map(([key, value]) => [escape(key), escape(value)]),
  );
}

/** A bulleted list. */
function list(items: readonly string[]): string {
  if (items.length === 0) return '';
  return `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`;
}

/** The stylesheet, inline because the document must open offline. */
const STYLE = `
:root { color-scheme: light dark; --line: #d0d7de; --muted: #57606a; --bad: #b42318; --good: #1a7f37; }
body { font-family: system-ui, -apple-system, "Noto Sans SC", sans-serif; line-height: 1.6; margin: 0 auto; max-width: 1200px; padding: 2rem 1.5rem 4rem; }
h1, h2, h3, h4 { line-height: 1.25; margin-top: 2rem; }
h1 { border-bottom: 2px solid var(--line); padding-bottom: .5rem; }
h2 { border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: .875rem; }
caption { text-align: left; font-weight: 600; padding: .25rem 0; }
th, td { border: 1px solid var(--line); padding: .35rem .5rem; text-align: left; vertical-align: top; }
th { background: rgba(127, 127, 127, .12); }
code { font-family: ui-monospace, "SFMono-Regular", monospace; font-size: .85em; }
.muted { color: var(--muted); }
.warn { background: rgba(180, 35, 24, .08); border-left: 4px solid var(--bad); padding: .75rem 1rem; margin: 1rem 0; }
.note { background: rgba(87, 96, 106, .08); border-left: 4px solid var(--muted); padding: .75rem 1rem; margin: 1rem 0; }
.bad { color: var(--bad); font-weight: 600; }
.good { color: var(--good); font-weight: 600; }
`;

/** The header: title, provenance and the top-level warning about a projection. */
function header(report: EvaluationReport): string {
  const warnings: string[] = [];
  if (report.setup.settlementProjection) {
    warnings.push(
      '第三层是按共享 settle() 规则推演的结果，不是宿主实际观察到的行为：本次运行没有格子经过宿主链。',
    );
  }
  if (report.diagnostics.labels.gold === 0) {
    warnings.push(
      '当前没有可计入金标的人类参考，因此第一层的比较分母和第二层都为 0，显示为 n/a。这是等待用户裁决的正常状态，不是 0% 通过率。',
    );
  }
  if (report.coverage.missing.length > 0) {
    warnings.push(
      `有 ${String(report.coverage.missing.length)} 个格子声称已派发却没有记录，这是真正的缺口。`,
    );
  }
  return [
    `<h1>评测报告 ${escape(report.run.runId)}</h1>`,
    p(
      '本报告由保存的运行记录离线重建：不新增请求、不覆盖证据、不回写任何标签。三层分开报告——主要自动行为指标、R/A 诊断、实际模式与宿主结算——技术失败不当成禁止。',
    ),
    warnings
      .map((warning) => `<div class="warn">${escape(warning)}</div>`)
      .join(''),
  ].join('');
}

/** The run identity tables. */
function identity(report: EvaluationReport): string {
  const run = report.run;
  return [
    h(2, '运行身份'),
    pairs('运行', [
      ['run', run.runId],
      ['状态', run.status],
      ['创建于', run.createdAt],
      ['最后更新', run.updatedAt],
      ['plan 哈希', run.planHash],
      ['数据集', `${run.datasetId} ${run.datasetDigest}`],
      ['数据集案例数', String(run.datasetCaseCount)],
      ['传输', run.transport],
      ['协议', run.protocols.join('、')],
      ['重复次数', String(run.repeats)],
      ['入口链', run.entryPoints.join('、') || '（无记录）'],
    ]),
    pairs('版本', [
      ['contract', run.versions.contract],
      ['prompt', run.versions.prompt],
      ['usage mapping', run.versions.usageMapping],
      ['plan', run.versions.plan],
      ['artifact', run.versions.artifact],
      ['implementation', run.versions.implementation],
      ['node', run.versions.node ?? '未知'],
    ]),
    table(
      '目标',
      ['target', 'provider/model', 'model 版本', '计划支持的协议'],
      run.targets.map((target) => [
        escape(target.targetId),
        escape(`${target.provider}/${target.model}`),
        escape(target.modelVersion ?? '未知'),
        escape(target.protocols.join('、') || '（无）'),
      ]),
    ),
    pairs('报告设置', [
      ['ask 模式', report.setup.mode],
      ['人工通道', report.setup.channel],
      ['标签来源', report.setup.labels],
      [
        '第三层口径',
        report.setup.settlementProjection ? '推演' : '宿主实际结算',
      ],
    ]),
  ].join('');
}

/** The coverage tables. */
function coverage(report: EvaluationReport): string {
  const coverage = report.coverage;
  return [
    h(2, '覆盖与分母'),
    p(
      '分母在这里公开。缺少记录的格子和派发前已决定的格子都不进入任何比率；前者是真正的缺口，后者是运行器的正常状态。',
    ),
    pairs('覆盖', [
      ['计划格子', String(coverage.cellsPlanned)],
      ['记录数', String(coverage.records)],
      ['宣称已派发但缺记录', String(coverage.missing.length)],
      ['attempt 总数', String(coverage.attempts)],
      ['已发送 attempt', String(coverage.sentAttempts)],
      ['未报告的预留 attempt', String(coverage.reservedAttempts)],
      ['观察到的案例', String(coverage.observedCases)],
      ['观察到的家族', String(coverage.observedFamilies)],
    ]),
    table(
      '格子状态分布',
      ['状态', '数量'],
      Object.entries(coverage.statuses).map(([status, count]) => [
        escape(status),
        escape(String(count)),
      ]),
    ),
    coverage.missing.length === 0
      ? ''
      : [
          h(3, '声称跑过却没有记录的格子'),
          list(
            coverage.missing.map(
              (cell) =>
                `${cell.cellId}：索引状态 ${cell.status}，记录文件 ${cell.record} 不存在。`,
            ),
          ),
        ].join(''),
  ].join('');
}

/** The class labels for the behaviour table. */
const CLASS_LABELS: readonly {
  readonly key: BehaviourClass;
  readonly label: string;
}[] = [
  { key: 'false-allow', label: '误放' },
  { key: 'false-deny', label: '误拒' },
  { key: 'unnecessary-human', label: '不必要人工' },
  { key: 'escalate-not-deny', label: '升级而非拒绝' },
  { key: 'material-unavailable-but-scored', label: '材料不足却判定' },
  { key: 'failure-expected-but-not-reported', label: '参考为故障却判定' },
  { key: 'undecided', label: '引擎拒答' },
  { key: 'matched', label: '一致' },
  { key: 'technical', label: '技术失败' },
  { key: 'missing-record', label: '缺记录' },
  { key: 'not-run', label: '派发前已决定' },
  { key: 'uncompared', label: '无参考可比' },
];

/** The behaviour counts table. */
function behaviourCounts(counts: BehaviourCounts): string {
  const entries: (readonly [string, string])[] = [
    ['格子', String(counts.cells)],
    ['已判定', String(counts.judged)],
    ['有金标参考', String(counts.referenceKnown)],
    ['参与比较的分母', String(counts.compared)],
    ...CLASS_LABELS.map((entry): readonly [string, string] => [
      entry.label,
      String(counts.byClass[entry.key]),
    ]),
    ['误放率', rateText(counts.falseAllow, counts.compared)],
    ['误拒率', rateText(counts.falseDeny, counts.compared)],
    ['不必要人工率', rateText(counts.unnecessaryHuman, counts.compared)],
    ['一致率', rateText(counts.matched, counts.compared)],
    [
      `按案例加权的一致率（${String(counts.caseBalanced.cases)} 个可比较案例）`,
      pct(counts.caseBalanced.agreementRate),
    ],
    ['按案例加权的误放率', pct(counts.caseBalanced.falseAllowRate)],
    ['按案例加权的误拒率', pct(counts.caseBalanced.falseDenyRate)],
    ['按案例加权的不必要人工率', pct(counts.caseBalanced.unnecessaryHumanRate)],
  ];
  return table(
    '第一层总计',
    ['指标', '值'],
    entries.map(([key, value]) => [escape(key), escape(value)]),
  );
}

/** The grouped behaviour tables. */
function behaviourGroups(groups: readonly BehaviourGroup[]): string {
  const axes = new Map<string, BehaviourGroup[]>();
  for (const group of groups) {
    const existing = axes.get(group.axis);
    if (existing === undefined) axes.set(group.axis, [group]);
    else existing.push(group);
  }
  return [...axes.entries()]
    .map(([axis, entries]) =>
      table(
        `按 ${axis} 分组`,
        [
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
        ],
        entries.map((entry) => [
          escape(entry.title),
          escape(String(entry.counts.cells)),
          escape(String(entry.counts.compared)),
          escape(String(entry.counts.matched)),
          escape(String(entry.counts.falseAllow)),
          escape(String(entry.counts.falseDeny)),
          escape(String(entry.counts.unnecessaryHuman)),
          escape(String(entry.counts.technical + entry.counts.missingRecord)),
          escape(String(entry.counts.uncompared + entry.counts.notRun)),
          escape(
            `${pct(entry.counts.agreementRate)} (${fraction(entry.counts.matched, entry.counts.compared)})`,
          ),
          escape(pct(entry.counts.caseBalanced.agreementRate)),
        ]),
      ),
    )
    .join('');
}

/** Layer one. */
function behaviour(report: EvaluationReport): string {
  return [
    h(2, '第一层：主要自动行为指标'),
    p(
      '分母只包含「引擎给出了对本次调用的判定」且「案例有可计入金标的参考」的格子。技术失败、缺记录与派发前已决定的格子都在分母之外，各自单列：把技术失败算成拒绝，会让一个坏掉的传输读起来像一个谨慎的审查者。',
    ),
    behaviourCounts(report.behaviour.overall),
    h(2, '分组（第一层）'),
    p(
      '同一张表同时给出按格子与按案例加权的比率：相关变体与重复共享 seed，不是独立样本，按案例加权给出「每个案例一票」的口径。',
    ),
    behaviourGroups(report.behaviour.byGroup),
  ].join('');
}

/** The label coverage tables. */
function labels(coverageOfLabels: LabelCoverage): string {
  const excluded = coverageOfLabels.rows.filter(
    (entry) => entry.outcome === 'excluded',
  );
  const absent = coverageOfLabels.rows.filter(
    (entry) => entry.outcome === 'missing' || entry.outcome === 'case-absent',
  );
  return [
    h(3, '标签覆盖与分母'),
    pairs('标签', [
      ['标签来源', coverageOfLabels.source],
      ['数据集', coverageOfLabels.datasetId ?? '（无）'],
      [
        '数据集版本',
        coverageOfLabels.versions === null
          ? '未知'
          : `${coverageOfLabels.versions.contract} / ${coverageOfLabels.versions.rubric} / ${coverageOfLabels.versions.policy}`,
      ],
      ['执行摘要', coverageOfLabels.executionDigest ?? '未知'],
      ['观察到的案例', String(coverageOfLabels.cases)],
      ['金标案例', String(coverageOfLabels.gold)],
      ['被排除', String(coverageOfLabels.excluded)],
      ['缺标签', String(coverageOfLabels.missing)],
      ['pending', String(coverageOfLabels.pending)],
      ['disputed', String(coverageOfLabels.disputed)],
    ]),
    table(
      '排除原因计数',
      ['原因', '数量'],
      Object.entries(coverageOfLabels.excludedByReason).map(
        ([reason, count]) => [escape(reason), escape(String(count))],
      ),
    ),
    excluded.length === 0
      ? ''
      : table(
          '被排除的标签',
          ['案例', '状态', '原因', '裁决理由'],
          excluded.map((entry) => [
            escape(entry.caseId),
            escape(entry.status ?? '（无）'),
            escape(entry.reasons.join('、') || '（无）'),
            escape(entry.rationale ?? ''),
          ]),
        ),
    absent.length === 0
      ? ''
      : [
          h(4, '没有可计入金标标签的案例'),
          list(
            absent.map(
              (entry) =>
                `${entry.caseId}：${entry.outcome === 'case-absent' ? '数据集未发布该案例' : '数据集中没有标签文件'}`,
            ),
          ),
        ].join(''),
  ].join('');
}

/** The two field error tables, as one row list over both fields. */
function fieldTable(
  risk: FieldErrorStats,
  authorization: FieldErrorStats,
): string {
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
  return table(
    '评分误差',
    ['指标', 'risk', 'authorization'],
    entries.map((entry) => [
      escape(entry.label),
      escape(entry.value(risk)),
      escape(entry.value(authorization)),
    ]),
  );
}

/** Layer two. */
function diagnostics(report: EvaluationReport): string {
  const section = report.diagnostics;
  const pairsStats = section.pairs;
  const gold = section.labels.gold;
  return [
    h(2, '第二层：R/A 诊断'),
    p(
      '这一层只解释第一层的判定，不参与判定。两个字段分别测量、从不合并成一个「评分质量」数字：偏差方向决定修复方式，单一数字会把方向抹掉。只有裁决者把某个字段钉为唯一值的案例才进入该字段的分母。',
    ),
    gold === 0
      ? `<div class="note">${escape('当前没有金标标签，因此本层所有比值都没有分母，显示为 n/a。这是等待用户裁决的正常状态，不是 0% 通过率。')}</div>`
      : '',
    labels(section.labels),
    fieldTable(section.risk, section.authorization),
    h(3, '合法配对命中'),
    pairs('配对', [
      ['有可判定配对的案例', String(pairsStats.labeled)],
      ['落在允许配对内', String(pairsStats.exactPair)],
      ['配对命中率', rateText(pairsStats.exactPair, pairsStats.labeled)],
    ]),
    pairsStats.outside.length === 0
      ? ''
      : table(
          '落在允许配对之外的案例',
          ['案例', '观察到的配对', '到最近允许配对的欧氏距离'],
          pairsStats.outside.map((entry) => [
            escape(entry.caseId),
            escape(`${String(entry.observed[0])}/${String(entry.observed[1])}`),
            escape(String(entry.distance)),
          ]),
        ),
    h(3, '单调性'),
    p(
      '只比较参考严格排序的案例对；同分是十档量表允许的，因此单列为「同分」，不算反向单调。',
    ),
    table(
      '单调性',
      ['字段', '可比较对', '反向', '同分', '反向率'],
      section.monotonicity.map((entry) => [
        escape(entry.field),
        escape(String(entry.comparablePairs)),
        escape(String(entry.reversals)),
        escape(String(entry.ties)),
        escape(rateText(entry.reversals, entry.comparablePairs)),
      ]),
    ),
    ...section.monotonicity
      .filter((entry) => entry.violations.length > 0)
      .map((entry) =>
        table(
          `${entry.field} 的反向单调`,
          ['参考更高', '参考更低', '参考对', '观察对'],
          entry.violations.map((violation) => [
            escape(violation.higher),
            escape(violation.lower),
            escape(
              `${String(violation.reference[0])}/${String(violation.reference[1])}`,
            ),
            escape(
              `${String(violation.observed[0])}/${String(violation.observed[1])}`,
            ),
          ]),
        ),
      ),
    h(3, '分布形态'),
    p('分布集中度是诊断，不是真实风险概率。均值只说明答案落在量表的哪个位置。'),
    table(
      '分布形态',
      ['字段', '观察案例', '参考案例', '众数', '众数占比', '不同取值', '均值'],
      section.shape.map((entry) => [
        escape(entry.field),
        escape(String(entry.observedCells)),
        escape(String(entry.referenceCells)),
        escape(num(entry.mode)),
        escape(pct(entry.modeShare)),
        escape(String(entry.distinct)),
        escape(num(entry.mean)),
      ]),
    ),
    ...section.shape.map((entry) =>
      table(
        `${entry.field} 分布`,
        ['档位', '观察', '参考'],
        Object.keys(entry.observed).map((level) => [
          escape(level),
          escape(String(entry.observed[level] ?? 0)),
          escape(
            entry.reference === null
              ? 'n/a'
              : String(entry.reference[level] ?? 0),
          ),
        ]),
      ),
    ),
  ].join('');
}

/** The settlement counts table. */
function settlementCounts(counts: SettlementCounts): string {
  const cost = humanCostOf(counts);
  const classified = cost.necessary + cost.unnecessary + cost.unknown;
  const entries: (readonly [string, string])[] = [
    ['格子', String(counts.cells)],
    ['allow', String(counts.allow)],
    ['deny', String(counts.deny)],
    ['归一为拒绝（无通道／no-ask）', String(counts.fallbackDeny)],
    ['询问人工', String(counts.askHuman)],
    ['未审查（无判定可结算）', String(counts.notReviewed)],
    ['其中来自技术故障的询问', String(counts.technical.askHuman)],
    ['其中来自技术故障的归一拒绝', String(counts.technical.fallbackDeny)],
    ['其中来自技术故障的未审查', String(counts.technical.notReviewed)],
    ['不必要的人工（参考已放行／拒绝）', String(cost.unnecessary)],
    ['必要的人工（参考要求升级）', String(cost.necessary)],
    ['必要性未知（无金标）', String(cost.unknown)],
    [
      '不必要人工占已分类提问',
      `${pct(cost.unnecessaryShare)} (${String(cost.unnecessary)}/${String(classified)})`,
    ],
  ];
  return table(
    '第三层结算',
    ['项目', '值'],
    entries.map(([key, value]) => [escape(key), escape(value)]),
  );
}

/** The grouped settlement tables. */
function settlementGroups(groups: readonly SettlementGroup[]): string {
  const axes = new Map<string, SettlementGroup[]>();
  for (const group of groups) {
    const existing = axes.get(group.axis);
    if (existing === undefined) axes.set(group.axis, [group]);
    else existing.push(group);
  }
  return [...axes.entries()]
    .map(([axis, entries]) =>
      table(
        `按 ${axis} 结算`,
        [
          '分组',
          '格子',
          'allow',
          'deny',
          '归一拒绝',
          '询问人工',
          '不必要人工',
          '未审查',
        ],
        entries.map((entry) => [
          escape(entry.title),
          escape(String(entry.counts.cells)),
          escape(String(entry.counts.allow)),
          escape(String(entry.counts.deny)),
          escape(String(entry.counts.fallbackDeny)),
          escape(String(entry.counts.askHuman)),
          escape(String(entry.counts.unnecessaryHuman)),
          escape(String(entry.counts.notReviewed)),
        ]),
      ),
    )
    .join('');
}

/** Layer three. */
function settlement(report: EvaluationReport): string {
  const section = report.settlement;
  return [
    h(2, '第三层：实际模式、人工与宿主结算'),
    section.projection
      ? `<div class="note">${escape('本次运行没有任何格子经过宿主链，因此这一层是按共享 settle() 规则推演的结果，不是宿主观察到的行为。')}</div>`
      : `<div class="note">${escape('本次运行包含宿主链格子，这一层反映宿主实际结算。')}</div>`,
    pairs('结算口径', [
      ['ask 模式', section.mode],
      ['人工通道', section.channel],
      ['计数口径', section.projection ? '推演' : '实际'],
    ]),
    settlementCounts(section.overall),
    p(
      '归一为拒绝与 deny 分开：前者是「本应问人但没有通道」，后者是审查结论本身。混成一个数字会把可用性问题读成质量结论。',
    ),
    settlementGroups(section.byGroup),
  ].join('');
}

/** One aggregate's buckets, as table rows. */
function bucketRows(
  aggregate: UsageAggregate | null,
): readonly (readonly string[])[] {
  if (aggregate === null) {
    return [['（无已发送 attempt）', '未知', '0', '0', '否'].map(escape)];
  }
  const buckets: readonly [string, UsageAggregate['totals']['inputTokens']][] =
    [
      ['input', aggregate.totals.inputTokens],
      ['output', aggregate.totals.outputTokens],
      ['total', aggregate.totals.totalTokens],
      ['cache 读取', aggregate.totals.cacheReadTokens],
      ['cache 写入', aggregate.totals.cacheWriteTokens],
      ['reasoning', aggregate.totals.reasoningTokens],
    ];
  return buckets.map(([name, total]) => [
    escape(name),
    escape(num(total.total)),
    escape(String(total.reported)),
    escape(String(total.missing)),
    escape(total.complete ? '是' : '否'),
  ]);
}

/** One attempt row. */
function attemptRow(attempt: AttemptUsageRow): string {
  return tr(
    [
      attempt.cellId,
      attempt.attemptId,
      attempt.kind,
      attempt.sent ? '已发送' : '未发送',
      num(attempt.tokens.inputTokens),
      num(attempt.tokens.outputTokens),
      num(attempt.tokens.totalTokens),
      num(attempt.tokens.cacheReadTokens),
      num(attempt.tokens.cacheWriteTokens),
      num(attempt.tokens.reasoningTokens),
      String(attempt.estimatedInputTokens),
      String(attempt.durationMs),
    ].map(escape),
  );
}

/** One scope table. */
function scopeTable(
  caption: string,
  key: string,
  scopes: readonly UsageScope[],
): string {
  return table(
    caption,
    [key, '格子', 'attempt', 'input', 'output', 'total', '完整'],
    scopes.map((scope) => [
      escape(scope.key),
      escape(String(scope.cells)),
      escape(String(scope.aggregate?.attempts ?? 0)),
      escape(num(scope.aggregate?.totals.inputTokens.total ?? null)),
      escape(num(scope.aggregate?.totals.outputTokens.total ?? null)),
      escape(num(scope.aggregate?.totals.totalTokens.total ?? null)),
      escape(
        scope.aggregate === null
          ? 'n/a'
          : scope.aggregate.totals.totalTokens.complete
            ? '是'
            : '否',
      ),
    ]),
  );
}

/** The usage extension. */
function usage(report: EvaluationReport): string {
  const section = report.usage;
  const run = section.run;
  return [
    h(2, '用量（逐 attempt／整次审查／model／protocol／run）'),
    p(
      `所有数字由共享 aggregateUsage 对记录中保存的 attempt 重新汇总得到，映射版本 ${section.mappingVersion}。缓存读写与 reasoning 保持独立桶并按声明的包含关系标注，不并入 input/output；未知保持未知，不填 0。`,
    ),
    table(
      '整次运行',
      ['口径', 'attempt', '有载荷', '重复剔除'],
      [
        [
          escape('run'),
          escape(String(run?.attempts ?? 0)),
          escape(String(run?.withUsage ?? 0)),
          escape(String(run?.duplicateAttempts ?? 0)),
        ],
      ],
    ),
    table(
      '整次运行六个桶',
      ['桶', '合计', '报告数', '缺失数', '完整'],
      bucketRows(run),
    ),
    pairs('包含关系', [
      ['cacheRead → input', run?.inclusions.cacheRead ?? 'unknown'],
      ['cacheWrite → input', run?.inclusions.cacheWrite ?? 'unknown'],
      ['reasoning → output', run?.inclusions.reasoning ?? 'unknown'],
    ]),
    h(3, '估算与实际 token 分开'),
    pairs('估算', [
      ['适配器估算 input token 合计', num(section.estimated.inputTokens)],
      ['估算覆盖的格子', String(section.estimated.cells)],
      ['已发送 attempt', String(section.estimated.attempts)],
      ['超时／取消时未报告的预留', String(section.unreportedReservations)],
    ]),
    list(section.notes),
    scopeTable('按模型', '模型', section.byModel),
    scopeTable('按协议', '协议', section.byProtocol),
    scopeTable('按目标', 'target', section.byTarget),
    h(3, '逐 attempt'),
    `<table><caption>${escape('逐 attempt')}</caption><thead>${tr(
      [
        'cell',
        'attemptId',
        'kind',
        '发送',
        'input',
        'output',
        'total',
        'cache 读',
        'cache 写',
        'reasoning',
        '估算 input',
        '耗时 ms',
      ].map(escape),
      true,
    )}</thead><tbody>${section.attempts.map(attemptRow).join('')}</tbody></table>`,
    table(
      '逐格（整次审查）',
      ['cell', '状态', 'attempt', '有载荷', '与记录自带汇总一致'],
      section.byCell.map((cell) => [
        escape(cell.cellId),
        escape(cell.status),
        escape(String(cell.aggregate?.attempts ?? 0)),
        escape(String(cell.aggregate?.withUsage ?? 0)),
        escape(
          cell.aggregate === null ? 'n/a' : cell.matchesRecord ? '是' : '否',
        ),
      ]),
    ),
    p(
      '逐格重算与记录自带汇总必须一致：不一致说明 artifact 的两个数字互相矛盾，报告按重算值输出并在自检里标出。',
    ),
  ].join('');
}

/** The stability section. */
function stability(report: EvaluationReport): string {
  const section = report.stability;
  const samples = section.samples;
  return [
    h(2, '重复稳定性与样本权重'),
    p(
      '相关变体与重复都不是独立样本：重复是同一个输入的第二次观测，只说明稳定性；变体与兄弟案例共享 seed，只说明机制覆盖。三者一起公开，因为任何一个单独出现都会误导。',
    ),
    pairs('样本权重', [
      ['格子', String(samples.cells)],
      ['记录', String(samples.records)],
      ['去重后的案例', String(samples.distinctCases)],
      ['家族', String(samples.distinctFamilies)],
      ['目标', String(samples.distinctTargets)],
      ['协议', String(samples.distinctProtocols)],
      ['重复序号 > 1 的格子', String(samples.repeats)],
      ['修复重试 attempt（计入消耗，不是重复）', String(samples.repairs)],
    ]),
    section.repeatGroups.length === 0
      ? p(
          '本次运行没有重复序号大于 1 的格子，因此没有稳定性样本；这不表示答案稳定，只表示没有重复观测。',
        )
      : table(
          '重复组',
          [
            '案例',
            'target',
            '协议',
            '重复数',
            '已判定',
            '稳定',
            '不同答案',
            'risk 极差',
            'authorization 极差',
          ],
          section.repeatGroups.map((group) => [
            escape(group.caseId),
            escape(group.targetId),
            escape(group.protocol),
            escape(String(group.repeats)),
            escape(String(group.judged)),
            escape(group.stable ? '是' : '否'),
            escape(String(group.distinctAnswers)),
            escape(num(group.riskSpread)),
            escape(num(group.authorizationSpread)),
          ]),
        ),
  ].join('');
}

/** One duration table. */
function durationTable(
  caption: string,
  key: string,
  entries: EvaluationReport['efficiency']['byTarget'],
): string {
  return table(
    caption,
    [key, '格子', '总计 ms', '平均 ms', '中位 ms', '最大 ms'],
    entries.map((entry) => [
      escape(entry.key),
      escape(String(entry.duration.cells)),
      escape(String(entry.duration.totalMs)),
      escape(num(entry.duration.meanMs)),
      escape(num(entry.duration.medianMs)),
      escape(num(entry.duration.maxMs)),
    ]),
  );
}

/** The efficiency section. */
function efficiency(report: EvaluationReport): string {
  const section = report.efficiency;
  return [
    h(2, '耗时与费用'),
    pairs('耗时', [
      ['有记录格子', String(section.duration.cells)],
      ['总耗时 ms', String(section.duration.totalMs)],
      ['平均 ms', num(section.duration.meanMs)],
      ['中位 ms', num(section.duration.medianMs)],
      ['最大 ms', num(section.duration.maxMs)],
    ]),
    durationTable('按目标', 'target', section.byTarget),
    durationTable('按协议', '协议', section.byProtocol),
    h(3, '费用'),
    `<div class="note">${escape(
      `费用是状态，不是数字：本次运行 ${String(section.cost.cells)} 个记录的 cost.amount 恒为 null（状态 ${section.cost.status}）。报告不代币定价，不输出任何费用合计；把这些格子写成 0 会被读成「免费调用」，那是另一个事实。`,
    )}</div>`,
    list(section.cost.reasons),
  ].join('');
}

/** The comparability section. */
function comparison(report: EvaluationReport): string {
  const section = report.comparison;
  return [
    h(2, '可比性'),
    p(
      '同模型双协议只在目标确实同时支持两种协议时比较；模型与协议同时变化时只报告系统组合，不归因于单一协议。',
    ),
    h(3, '同模型双协议比较'),
    section.protocolComparisons.length === 0
      ? p('本次运行没有同模型双协议比较。')
      : table(
          '同模型双协议',
          [
            'target',
            'model',
            '依据',
            '案例',
            '配对',
            '行为一致',
            '配对一致率',
            '评分一致',
          ],
          section.protocolComparisons.map((entry) => [
            escape(entry.targetId),
            escape(entry.model),
            escape(entry.basis),
            escape(String(entry.cases)),
            escape(String(entry.paired)),
            escape(String(entry.behaviourAgree)),
            escape(rateText(entry.behaviourAgree, entry.paired)),
            escape(String(entry.scoreAgree)),
          ]),
        ),
    ...section.protocolComparisons
      .filter((entry) => entry.differences.length > 0)
      .map((entry) =>
        table(
          `${entry.targetId} 的配对差异`,
          ['案例', 'chat 配对', 'decision 配对'],
          entry.differences.map((difference) => [
            escape(difference.caseId),
            escape(
              `${String(difference.chat[0])}/${String(difference.chat[1])}`,
            ),
            escape(
              `${String(difference.decision[0])}/${String(difference.decision[1])}`,
            ),
          ]),
        ),
      ),
    section.systems.length === 0
      ? ''
      : [
          h(3, '系统组合（不作协议归因）'),
          table(
            '系统组合',
            ['组合', 'model', '协议', '原因'],
            section.systems.map((entry) => [
              escape(entry.targetId),
              escape(entry.model),
              escape(entry.protocols.join(' ↔ ')),
              escape(entry.reason),
            ]),
          ),
        ].join(''),
    section.unsupported.length === 0
      ? ''
      : [
          h(3, '计划声明但不支持的组合'),
          list(
            section.unsupported.map(
              (entry) => `${entry.targetId}：${entry.reason}`,
            ),
          ),
        ].join(''),
    section.notes.length === 0
      ? ''
      : [h(3, '可比性说明'), list(section.notes)].join(''),
  ].join('');
}

/** The differences section. */
function differences(report: EvaluationReport): string {
  const rows = report.differences;
  if (rows.length === 0) {
    return [h(2, '差异'), p('本次运行没有可报告的差异。')].join('');
  }
  const kinds = new Map<string, DifferenceRow[]>();
  for (const difference of rows) {
    const existing = kinds.get(difference.kind);
    if (existing === undefined) kinds.set(difference.kind, [difference]);
    else existing.push(difference);
  }
  return [
    h(2, '差异'),
    p(
      '行为差异与评分差异分开：判定正确但档位偏离是校准发现，不是质量失败，两者的修复方式不同。',
    ),
    ...[...kinds.entries()].map(([kind, entries]) =>
      table(
        `差异类型 ${kind}`,
        ['cell', '案例', '观察', '期望', '说明'],
        entries.map((entry) => [
          escape(entry.cellId === '' ? '（数据集）' : entry.cellId),
          escape(entry.caseId === '' ? '（数据集）' : entry.caseId),
          escape(entry.observed),
          escape(entry.expected),
          escape(entry.detail),
        ]),
      ),
    ),
  ].join('');
}

/** One per-example row. */
function exampleRow(example: CellView): string {
  return tr(
    [
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
    ].map(escape),
  );
}

/** The per-example evidence. */
function examples(report: EvaluationReport): string {
  return [
    h(2, '逐例证据'),
    p(
      '每一行对应一个计划格子，包括从未运行的格子；把未运行的格子移出表格，会让一个小分母看起来像完整覆盖。输入指纹是标签审批所用的同一摘要，案例与标签路径相对数据集目录。引擎答案与人类参考分列，从不合并成一列。',
    ),
    `<table><caption>${escape('逐例证据')}</caption><thead>${tr(
      [
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
      ].map(escape),
      true,
    )}</thead><tbody>${report.examples.map(exampleRow).join('')}</tbody></table>`,
  ].join('');
}

/** The self-checks and notes. */
function closing(report: EvaluationReport): string {
  return [
    h(2, '自检'),
    p(
      '这些不是通过／失败门槛：运行被中断时报告仍然有用，所以自检结果作为事实公开。',
    ),
    table(
      '自检',
      ['检查', '结果', '说明'],
      report.checks.map((check) => [
        escape(check.name),
        check.ok ? '通过' : '<span class="bad">未通过</span>',
        escape(check.detail),
      ]),
    ),
    h(2, '说明'),
    report.notes.length === 0 ? p('无额外说明。') : list(report.notes),
  ].join('');
}

/**
 * Render one report as a self-contained HTML document.
 *
 * The `<meta charset>` is first because the document is Chinese and a browser that
 * guessed would render it as mojibake; the doctype is before that because a standards
 * mode document is what keeps the table layout predictable across browsers.
 */
export function renderHtml(report: EvaluationReport): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>评测报告 ${escape(report.run.runId)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    header(report),
    identity(report),
    coverage(report),
    behaviour(report),
    diagnostics(report),
    settlement(report),
    usage(report),
    stability(report),
    efficiency(report),
    comparison(report),
    differences(report),
    examples(report),
    closing(report),
    '</body>',
    '</html>',
  ].join('\n');
}
