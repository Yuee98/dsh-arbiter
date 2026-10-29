/**
 * The usage extension's rendering: per attempt, per review, and per scope.
 *
 * The tables print the six buckets separately and never a combined total, because the
 * contract says a cache read or a reasoning count may already sit inside its parent.
 * Summing them would produce a number that is neither the provider's total nor the sum
 * of what it reported, and the whole point of the shared mapping is that this report
 * cannot introduce such a number.
 *
 * Coverage is printed beside every sum. A total over four of five attempts is still
 * printed — the four attempts' mass is real — but `完整` says `否`, and the coverage
 * columns say how many reported and how many did not. A reader who needs a strict total
 * checks that column; a reader who does not is not misled into thinking they have one.
 */

import type { UsageAggregate } from '../../../src/reviewer/usage.js';
import type {
  AttemptUsageRow,
  EvaluationReport,
  UsageScope,
} from '../metrics/types.js';
import { heading, num, row, separator } from './format.js';

/** One aggregate's six buckets, as rows with their coverage. */
function aggregateRows(aggregate: UsageAggregate | null): readonly string[] {
  if (aggregate === null) {
    return [row(['（无已发送 attempt）', '未知', '0', '0', '否'])];
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
  return buckets.map(([name, total]) =>
    row([
      name,
      num(total.total),
      String(total.reported),
      String(total.missing),
      total.complete ? '是' : '否',
    ]),
  );
}

/** One scope's six buckets, as rows with their own coverage. */
function scopeRows(scope: UsageScope): readonly string[] {
  if (scope.aggregate === null) {
    return [row([scope.key, '（无已发送 attempt）', '未知', '0', '0', '否'])];
  }
  return scope.fields.map((field) =>
    row([
      scope.key,
      field.field,
      num(field.total),
      String(field.reported),
      String(field.missing),
      field.complete ? '是' : '否',
    ]),
  );
}

/** The attempt count and cell count a scope's table needs above its buckets. */
function scopeSummary(scope: UsageScope): string {
  return `${scope.key}：${String(scope.cells)} 个格子、${String(scope.aggregate?.attempts ?? 0)} 个已发送 attempt`;
}

/** One attempt row of the per-attempt table. */
function attemptRow(attempt: AttemptUsageRow): string {
  return row([
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
  ]);
}

/**
 * One scope table, over all six buckets.
 *
 * Empty and partially known are different states and are printed differently: a scope with
 * no sent attempt says so rather than showing zeroes, and a bucket whose coverage is
 * incomplete says `否` in its own row rather than borrowing another bucket's flag.
 */
function scopeTable(
  title: string,
  key: string,
  scopes: readonly UsageScope[],
): string {
  return [
    heading(3, title),
    '',
    row([key, '桶', '合计', '报告数', '缺失数', '该桶完整']),
    separator(6),
    ...scopes.flatMap(scopeRows),
    '',
    ...(scopes.length === 0 ? [] : [scopes.map(scopeSummary).join('；'), '']),
  ].join('\n');
}

/** The usage extension section. */
export function usageSection(report: EvaluationReport): string {
  const usage = report.usage;
  const run = usage.run;
  return [
    heading(2, '用量（逐 attempt／整次审查／model／protocol／run）'),
    '',
    `所有数字由共享 \`aggregateUsage\` 对记录中保存的 attempt 重新汇总得到，映射版本 \`${usage.mappingVersion}\`。缓存读写与 reasoning 保持独立桶并按声明的包含关系标注，**不并入 input/output**；未知保持未知，不填 0。`,
    '',
    heading(3, '整次运行'),
    '',
    row(['口径', 'attempt', '有载荷', '重复剔除']),
    separator(4),
    row([
      'run',
      String(run?.attempts ?? 0),
      String(run?.withUsage ?? 0),
      String(run?.duplicateAttempts ?? 0),
    ]),
    '',
    row(['桶', '合计', '报告数', '缺失数', '完整']),
    separator(5),
    ...aggregateRows(run),
    '',
    row(['包含关系', '值']),
    separator(2),
    row(['cacheRead → input', run?.inclusions.cacheRead ?? 'unknown']),
    row(['cacheWrite → input', run?.inclusions.cacheWrite ?? 'unknown']),
    row(['reasoning → output', run?.inclusions.reasoning ?? 'unknown']),
    '',
    heading(3, '估算与实际 token 分开'),
    '',
    '适配器估算的 input token 与 provider 报告的计数是两个不同的量，报告不把它们相加。',
    '',
    row(['项目', '值']),
    separator(2),
    row(['适配器估算 input token 合计', num(usage.estimated.inputTokens)]),
    row(['估算覆盖的格子', String(usage.estimated.cells)]),
    row(['已发送 attempt', String(usage.estimated.attempts)]),
    row(['超时／取消时未报告的预留', String(usage.unreportedReservations)]),
    '',
    ...(usage.notes.length === 0
      ? []
      : [usage.notes.map((note) => `- ${note}`).join('\n'), '']),
    scopeTable('按模型', '模型', usage.byModel),
    scopeTable('按协议', '协议', usage.byProtocol),
    scopeTable('按目标', 'target', usage.byTarget),
    heading(3, '逐 attempt'),
    '',
    row([
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
    ]),
    separator(12),
    ...usage.attempts.map(attemptRow),
    '',
    heading(3, '逐格（整次审查）'),
    '',
    row(['cell', '状态', 'attempt', '有载荷', '与记录自带汇总一致']),
    separator(5),
    ...usage.byCell.map((cell) =>
      row([
        cell.cellId,
        cell.status,
        String(cell.aggregate?.attempts ?? 0),
        String(cell.aggregate?.withUsage ?? 0),
        cell.aggregate === null ? 'n/a' : cell.matchesRecord ? '是' : '**否**',
      ]),
    ),
    '',
    '逐格重算与记录自带汇总必须一致：不一致说明 artifact 的两个数字互相矛盾，报告按重算值输出并在自检里标出。',
    '',
  ].join('\n');
}
