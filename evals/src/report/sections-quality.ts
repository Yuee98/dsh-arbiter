/** Rendering only: all denominators and classifications come from metrics. */
import type { EvaluationReport } from '../metrics/types.js';
import type { ConditionalQuality, Fraction } from '../metrics/quality-types.js';
import { heading, rateText, row, separator } from './format.js';
import { compactText } from './compact.js';

function fraction(value: Fraction): string {
  return rateText(value.numerator, value.denominator);
}
function conditionalRows(quality: ConditionalQuality): readonly string[] {
  return [
    ['直接误放／参考 deny 或 escalate', quality.falseAllow],
    ['误拒／参考 allow 或 escalate', quality.falseDeny],
    ['误拒／参考 allow', quality.falseDenyFromAllow],
    ['误拒／参考 escalate', quality.falseDenyFromEscalate],
    ['不必要人工／参考 allow', quality.unnecessaryHuman],
    ['不必要人工占全部比较点', quality.unnecessaryHumanOfCompared],
    ['应拒却升级／参考 deny', quality.escalateNotDeny],
  ].map(([title, value]) =>
    typeof title === 'string' &&
    typeof value !== 'string' &&
    value !== undefined
      ? row([title, fraction(value)])
      : '',
  );
}
export function qualitySection(report: EvaluationReport): string {
  const quality = report.quality;
  if (quality === undefined) return '';
  const overall = quality.overall;
  const burden = overall.burden;
  return [
    heading(2, '多来源参考与条件分母'),
    '',
    '人工、继承、模型暂定参考与未解决状态分开。模型参考成绩仅表示与固定模型共识的符合程度，不是人工金标或正式资格通过。legacy 是历史契约回归。',
    '',
    row([
      '冻结参考 split/group/协议',
      '参考来源 commit（非被测 head）',
      'dirty',
      '快照时间',
    ]),
    separator(4),
    ...(report.setup.referenceSnapshots ?? []).map((snapshot) =>
      row([
        `${snapshot.split}/${snapshot.group}/${snapshot.protocol}`,
        snapshot.sourceCommit ?? '未记录',
        snapshot.sourceDirty === null ? '未知' : String(snapshot.sourceDirty),
        snapshot.createdAt,
      ]),
    ),
    '',
    '原始 cell 保留所有 repeats；以下条件率选最低计划 repeat（失败也保留）。R/A 诊断沿用最低有效评分观测；两者分母分别列出。',
    '',
    row(['统计单位', '数量']),
    separator(2),
    ...Object.entries(quality.identities).map(([key, count]) =>
      row([key, String(count)]),
    ),
    '',
    'root/lineage 是来源计数，不是独立同分布样本证明；诊断 view、target、repeat 和 repair 不增加独立根。',
    '',
    row(['参考来源', '计划 cell', '参考适用条件（不含 target/repeat 重复）']),
    separator(3),
    ...Object.entries(quality.references.cellsBySource).map(([source, count]) =>
      row([
        source,
        String(count),
        String(quality.references.unitsBySource[source] ?? 0),
      ]),
    ),
    '',
    row([
      '模型参考 view',
      '协议',
      'N',
      'K',
      '采用分支',
      '返回',
      '有效',
      '缺答',
      '失败',
    ]),
    separator(9),
    ...quality.references.consensus.map((entry) =>
      row([
        entry.view,
        entry.protocol,
        String(entry.n),
        String(entry.k),
        entry.branch ?? '未采用',
        String(entry.returned),
        String(entry.valid),
        String(entry.missing),
        String(entry.failed),
      ]),
    ),
    '',
    row(['条件指标', '比例（分子／分母）']),
    separator(2),
    ...conditionalRows(overall.conditional),
    row([
      '技术可用性／实际支持且应请求',
      fraction(overall.technicalAvailability),
    ]),
    row([
      'M0 参考／观察／匹配',
      `${String(overall.m0.expected)} / ${String(overall.m0.observed)} / ${String(overall.m0.matched)}`,
    ]),
    row([
      'M0 已知未派发／意外派发／派发未知',
      `${String(overall.m0.knownNoDispatch)} / ${String(overall.m0.unexpectedDispatch)} / ${String(overall.m0.unknownDispatch)}`,
    ]),
    row([
      '工程故障参考／观察／匹配',
      `${String(overall.reviewFailure.expected)} / ${String(overall.reviewFailure.observed)} / ${String(overall.reviewFailure.matched)}`,
    ]),
    '',
    row(['参考行为', '实际行为', '数量']),
    separator(3),
    ...overall.conditional.confusion.map((entry) =>
      row([entry.reference, entry.actual, String(entry.count)]),
    ),
    '',
    heading(3, '参考 allow 的端到端负担与证据缺口'),
    '',
    '结算按规则推演，派发阻断来自记录；此处下界不是完整宿主实测负担率。unsupported、缺记录、未开始及未知后果均不冒充 deny。实际续行为 not-observed。',
    '',
    row([
      '统计单位',
      '计划 allow',
      '支持的 allow',
      '派发前阻断',
      'unsupported',
      '未知后果',
      '负担下界',
    ]),
    separator(7),
    ...(
      [
        ['全部计划 cell（含 repeats）', overall.cellBurden],
        ['最低计划 repeat 条件', burden],
      ] as const
    ).map(([unit, summary]) => {
      return row([
        unit,
        String(summary.plannedAllow),
        String(summary.supportedAllow),
        String(summary.preDispatchBlocked),
        String(summary.unsupported),
        String(summary.unknown),
        fraction(summary.knownBurdenLowerBound),
      ]);
    }),
    '',
    '以下详细推演分布使用最低计划 repeat 条件：',
    '',
    row(['指标', '数量或比例']),
    separator(2),
    row(['全部计划 allow', String(burden.plannedAllow)]),
    row(['其中支持的 allow', String(burden.supportedAllow)]),
    row([
      '已知负担／全部计划 allow（下界）',
      fraction(burden.knownBurdenLowerBound),
    ]),
    row([
      '已知负担／支持的 allow（下界）',
      fraction(burden.supportedBurdenLowerBound),
    ]),
    row(['派发前阻断', String(burden.preDispatchBlocked)]),
    row(['unsupported', String(burden.unsupported)]),
    row(['未知后果', String(burden.unknown)]),
    ...Object.entries(burden.projected).map(([kind, count]) =>
      row([`推演 ${kind}`, String(count)]),
    ),
    '',
    heading(3, '业务、split、target 与参考分类'),
    '',
    row([
      '分类轴',
      '分类',
      '计划 cell',
      '条件',
      '比较条件',
      '条件误放',
      '条件误拒',
      '条件人工',
      '全部 allow 负担下界',
      'R/A 配对命中',
    ]),
    separator(10),
    ...quality.byGroup.map(({ axis, key, population }) =>
      row([
        axis,
        key,
        String(population.cells.cells),
        String(population.conditions.cells),
        String(population.conditions.compared),
        fraction(population.conditional.falseAllow),
        fraction(population.conditional.falseDeny),
        fraction(population.conditional.unnecessaryHuman),
        fraction(population.burden.knownBurdenLowerBound),
        rateText(population.pairs.exactPair, population.pairs.labeled),
      ]),
    ),
    '',
    trajectorySection(report),
    relationSection(report),
    detailsSection(report),
  ].join('\n');
}
function trajectorySection(report: EvaluationReport): string {
  const trajectories = report.trajectories;
  if (trajectories === undefined) return '';
  return [
    heading(3, '固定源轨迹（非自主任务完成率）'),
    '',
    row([
      '选中轨迹条件',
      '完整范围',
      '完整可评',
      '全部一致',
      '有偏离',
      '不完整',
      '部分范围',
      '完整可评一致率',
    ]),
    separator(8),
    row([
      String(trajectories.selected),
      String(trajectories.completeScope),
      String(trajectories.assessable),
      String(trajectories.satisfied),
      String(trajectories.violated),
      String(trajectories.incomplete),
      String(trajectories.partialScope),
      fraction(trajectories.agreement),
    ]),
    '',
    row([
      'root',
      'branch',
      'target/协议/repeat',
      '状态',
      '首次观察到偏离',
      '首个不可评点',
      '节点',
    ]),
    separator(7),
    ...trajectories.rows.map((entry) =>
      row([
        entry.rootId,
        entry.branchId,
        `${entry.targetId}/${entry.protocol}/${String(entry.repeat)}`,
        entry.status,
        entry.firstObservedDeviation ?? '无',
        entry.firstUnassessable ?? '无',
        entry.nodes
          .map((node) => `${node.pointId}/${node.viewId}:${node.result}`)
          .join(' → '),
      ]),
    ),
    '实际宿主续行：not-observed。没有登记的链不生成轨迹分母。',
    '',
  ].join('\n');
}
function relationSection(report: EvaluationReport): string {
  const relations = report.relations;
  if (relations === undefined) return '';
  return [
    heading(3, '预登记关系'),
    '',
    '受控关系比较唯一参考字段确定的方向或不变性，允许同向 tie；多值或缺失时不可评。natural 仅描述变化，不从自由文本推断不变量。',
    '',
    row([
      '关系字段',
      '计划两端比较',
      '可评',
      '满足',
      '违反',
      '不可评',
      '描述性',
      '满足率',
    ]),
    separator(8),
    ...Object.entries(relations.fields).map(([field, counts]) =>
      row([
        field,
        String(counts.planned),
        String(counts.assessable),
        String(counts.satisfied),
        String(counts.violated),
        String(counts.unassessable),
        String(counts.descriptive),
        fraction(counts.agreement),
      ]),
    ),
    '',
    row([
      '选中关系条件',
      '可确定',
      '满足',
      '违反',
      '不可评',
      '描述性',
      '可确定关系满足率',
    ]),
    separator(7),
    row([
      String(relations.selected),
      String(relations.determinate),
      String(relations.satisfied),
      String(relations.violated),
      String(relations.unassessable),
      String(relations.descriptive),
      fraction(relations.agreement),
    ]),
    '',
    row([
      'root/relation',
      'target/协议/repeat',
      'kind',
      '状态',
      '两端／字段／参考变化／实际变化／违例幅度',
    ]),
    separator(5),
    ...relations.rows.map((entry) =>
      row([
        `${entry.rootId}/${entry.relationId}`,
        `${entry.targetId}/${entry.protocol}/${String(entry.repeat)}`,
        entry.kind,
        entry.status,
        entry.fields
          .map(
            (field) =>
              `${field.leftPointId}→${field.rightPointId} ${field.field}: ${String(field.expectedDelta)} / ${String(field.observedDelta)} / ${String(field.violationMagnitude)} (${field.status}${field.tied ? ', tie' : ''})`,
          )
          .join('; '),
      ]),
    ),
    '',
  ].join('\n');
}
function detailsSection(report: EvaluationReport): string {
  return [
    heading(3, '全计划身份与参考明细'),
    '',
    row([
      'cell',
      '内容集',
      'root/lineage',
      'point/view 或 legacy case',
      'target/协议/repeat',
      '参考来源/资格',
      '参考 R/A/行为',
      '实际 R/A/行为',
      '状态/分类',
      '参考原因',
    ]),
    separator(10),
    ...report.examples.map((entry) => {
      const source = entry.source;
      const reference = entry.evaluationReference;
      const target = reference?.target;
      return row([
        entry.cellId,
        source?.kind === 'workflow' ? 'workflows-v1' : 'legacy-v1',
        source?.kind === 'workflow'
          ? `${source.rootId}/${source.lineageId}`
          : '—',
        source?.kind === 'workflow'
          ? `${source.pointId}/${source.viewId}`
          : entry.caseId,
        `${entry.targetId}/${entry.protocol}/${String(entry.repeat)}`,
        `${reference?.source ?? 'unresolved'}; human=${String(reference?.humanConfirmed ?? false)}, behaviour=${String(reference?.behaviourEligible ?? false)}, score=${String(reference?.scoringEligible ?? false)}`,
        `${JSON.stringify(target?.allowedPairs ?? target?.allowed ?? null)} / ${entry.reference ?? '未知'}`,
        `${String(entry.engine.risk)}/${String(entry.engine.authorization)} / ${entry.engine.word ?? '未知'}`,
        `${entry.status}/${entry.classification}`,
        compactText(
          reference?.reasons.join('; ') ?? entry.labelReasons.join('; '),
        ),
      ]);
    }),
    '',
  ].join('\n');
}
