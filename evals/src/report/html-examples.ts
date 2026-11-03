/** Complete planned rows and public evidence, with presentation-only filter metadata. */
import type { CellView, DifferenceRow } from '../metrics/types.js';
import type { ReportCellEvidence } from './evidence.js';
import type { PublicationCell, PublishedReport } from './publication-types.js';
import { escape } from './html-format.js';

const FILTERS = [
  ['business', '业务'],
  ['dataset', '数据集来源'],
  ['provenance', '案例来源'],
  ['reference', '参考来源'],
  ['status', '索引状态'],
] as const;
type Filter = (typeof FILTERS)[number][0];
type Facets = Readonly<Record<Filter, string | null>>;

export const EXAMPLES_STYLE = `
[hidden] { display: none !important; }
.report-controls { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; padding: 1rem; border: 1px solid var(--line); }
.report-controls label { display: flex; flex-direction: column; gap: .25rem; }
.report-controls input, .report-controls select, .report-controls button { font: inherit; padding: .35rem; max-width: 100%; }
.report-table { overflow: auto; }
.example-table { min-width: 70rem; }
.example-table td { overflow-wrap: anywhere; }
.example-table details { min-width: 12rem; }
summary { cursor: pointer; padding: .3rem 0; }
.evidence-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 24rem; overflow: auto; max-width: 55rem; min-width: 16rem; padding: .6rem; border: 1px solid var(--line); font-size: .85rem; }
.evidence-text:focus-visible, summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
`;

function facets(cell: CellView): Facets {
  return {
    business:
      cell.source?.kind === 'workflow' ? cell.source.group : 'legacy-v1',
    dataset: cell.source?.kind ?? null,
    provenance: cell.provenance,
    reference: cell.evaluationReference?.source ?? null,
    status: cell.status,
  };
}

function label(value: string | null): string {
  return value === null ? '未提供' : value === '' ? '（空）' : value;
}

function control(
  key: Filter,
  title: string,
  values: readonly Facets[],
): string {
  const options = [...new Set(values.map((value) => value[key]))].sort(
    (a, b) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0),
  );
  return `<label for="filter-${key}">${title}<select id="filter-${key}" data-filter="${key}" aria-controls="planned-examples"><option value="">全部</option>${options.map((value) => `<option value="${escape(JSON.stringify(value))}">${escape(label(value))}</option>`).join('')}</select></label>`;
}

function textBlock(title: string, text: string | null): string {
  if (text === null) return `<p>${escape(title)}：未保存正文。</p>`;
  if (text === '') return `<p>${escape(title)}：已保存空正文。</p>`;
  const note =
    text === '[redacted]'
      ? '（已遮蔽）'
      : text === '[unavailable]'
        ? '（公开投影不可用）'
        : '';
  return `<details><summary>${escape(title + note)}</summary><pre class="evidence-text" tabindex="0" aria-label="${escape(title)}">${escape(text)}</pre></details>`;
}

function storedEvidence(evidence: ReportCellEvidence | undefined): string {
  if (evidence === undefined)
    return '<p>未提供材料公开视图；不从当前输入重建历史正文。</p>';
  const descriptions: Readonly<Record<ReportCellEvidence['status'], string>> = {
    published:
      '已保存材料的公开文本（可能已遮蔽）；不是未遮蔽的原始字节，也不构成通用保密性认证。',
    'omitted-private-context':
      '正文未公开：运行含私有指导；请求、响应回显、错误及材料正文均省略。请在授权范围内核对本机工件。',
    'unverified-context':
      '正文未公开：无法确认保存的配置或来源；不根据当前材料重建历史正文。',
    'no-record': '没有已保存记录，不能提供原文。',
  };
  return [
    `<p>${escape(descriptions[evidence.status])}</p>`,
    evidence.status === 'published'
      ? textBlock('材料完整性与缺口', evidence.materialText)
      : '',
    evidence.attempts.length === 0 ? '<p>没有已保存的尝试。</p>' : '',
    ...evidence.attempts.map(
      (attempt) =>
        `<details><summary>尝试 ${String(attempt.attempt)} · ${escape(attempt.kind)} · ${attempt.sent ? '已发送' : '发送前拒绝'}</summary>${evidence.status === 'published' ? [textBlock('保存的请求（结构值按 JSON 展示）', attempt.requestText), textBlock('保存的模型响应', attempt.responseText), textBlock('保存的错误', attempt.errorText)].join('') : '<p>该尝试正文未公开。</p>'}</details>`,
    ),
  ].join('');
}

function differences(rows: readonly DifferenceRow[]): string {
  return `<details><summary>本格差异（${String(rows.length)}）</summary>${rows.length === 0 ? '<p>没有本格差异。</p>' : rows.map((row) => `<p>${escape(row.kind)}：观察 ${escape(row.observed)}；期望 ${escape(row.expected)}</p>${textBlock('差异说明', row.detail)}`).join('')}</details>`;
}

function exampleRow(
  cell: CellView,
  value: Facets,
  saved: PublicationCell | undefined,
  evidence: ReportCellEvidence | undefined,
  findings: readonly DifferenceRow[],
): string {
  const identity =
    cell.source?.kind === 'workflow'
      ? `${cell.source.rootId} / ${cell.source.pointId} / ${cell.source.viewId}`
      : cell.caseId;
  const engine =
    cell.engine.word === null
      ? '（无判定）'
      : cell.engine.risk === null
        ? cell.engine.word
        : `${cell.engine.word} ${String(cell.engine.risk)}/${String(cell.engine.authorization)}`;
  const detail = [
    differences(findings),
    textBlock('裁决理由', cell.rationale),
    textBlock('引擎说明', cell.engine.reason),
    textBlock(
      '参考配对',
      JSON.stringify(
        cell.evaluationReference?.target?.allowedPairs ??
          cell.evaluationReference?.target?.allowed ??
          null,
      ),
    ),
    `<p>家族：${escape(cell.familyId)}；案例：${escape(cell.casePath ?? '未读到')}；标签：${escape(cell.labelPath ?? '无标签')}；输入指纹：${escape(cell.inputHash || '无记录')}</p>`,
    `<p>本机记录：${escape(saved?.recordPath ?? '未提供可定位的已保存记录')}。仅为本机定位，不代表已归档附件或文件仍可用。</p>`,
    storedEvidence(evidence),
  ].join('');
  const cells = [
    escape(cell.cellId),
    escape(identity),
    escape(`${cell.targetId} / ${cell.protocol} / r${String(cell.repeat)}`),
    escape(
      `${label(value.business)} / ${label(value.dataset)} / ${label(value.provenance)}`,
    ),
    escape(label(value.reference)),
    escape(
      `${cell.status} / ${saved === undefined ? '记录状态未提供' : (saved.recordStatus ?? '无记录')} / ${saved?.reason ?? (saved === undefined ? '一致性未提供' : '一致')}`,
    ),
    escape(`${cell.classification} / ${cell.settlement}`),
    escape(engine),
    escape(cell.reference ?? '（无参考）'),
    `<details><summary>差异与材料</summary>${detail}</details>`,
  ];
  const attributes = FILTERS.map(
    ([key]) => `data-${key}="${escape(JSON.stringify(value[key]))}"`,
  ).join(' ');
  return `<tr data-example ${attributes}>${cells.map((text) => `<td>${text}</td>`).join('')}</tr>`;
}

export function examples(report: PublishedReport): string {
  const values = report.examples.map(facets);
  const persisted = new Map(
    report.publication?.consistency.cells.map((cell) => [cell.cellId, cell]),
  );
  const evidence = new Map(report.evidence?.map((cell) => [cell.cellId, cell]));
  const findings = new Map<string, DifferenceRow[]>();
  for (const row of report.differences) {
    const group = findings.get(row.cellId) ?? [];
    group.push(row);
    findings.set(row.cellId, group);
  }
  const headings = [
    'cell',
    'root / point / view 或案例',
    'target / 协议 / 重复',
    '业务 / 数据集 / 案例来源',
    '参考来源',
    '索引 / 记录状态 / 一致性',
    '分类 / 结算',
    '引擎',
    '参考',
    '逐点证据',
  ];
  return [
    '<section id="example-browser"><h2>逐例证据</h2>',
    '<p>覆盖全部计划格子，包括未运行格子。仅筛选逐例显示；全局指标、分母及上方全局差异不变。数据集来源、案例来源和参考来源分别列明。引擎答案与参考分列。</p>',
    `<div class="report-controls" data-controls hidden><label for="example-search">关键词<input id="example-search" type="search" data-search aria-controls="planned-examples" placeholder="搜索身份、理由、差异与已公开材料"></label>${FILTERS.map(([key, title]) => control(key, title, values)).join('')}<button type="button" data-reset>清空筛选</button></div>`,
    `<p data-count role="status" aria-live="polite">当前可见 ${String(report.examples.length)} / 全计划 ${String(report.examples.length)} 格</p>`,
    '<p data-empty hidden>没有匹配的计划格子；清空筛选可恢复全部记录。</p>',
    '<div class="report-table"><table id="planned-examples" class="example-table"><caption>逐例证据</caption>',
    `<thead><tr>${headings.map((title) => `<th scope="col">${escape(title)}</th>`).join('')}</tr></thead><tbody>`,
    ...report.examples.map((cell) =>
      exampleRow(
        cell,
        facets(cell),
        persisted.get(cell.cellId),
        evidence.get(cell.cellId),
        findings.get(cell.cellId) ?? [],
      ),
    ),
    '</tbody></table></div></section>',
  ].join('');
}
