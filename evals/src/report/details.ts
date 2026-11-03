/** Stable grouped Markdown from the exact same planned examples; no second metrics. */
import { basename } from 'node:path';
import type { CellView } from '../metrics/types.js';
import type { PublishedReport } from './publication-types.js';
import { heading, row, separator } from './format.js';
import { compactText } from './compact.js';

function groupOf(cell: CellView): string {
  return cell.source?.kind === 'workflow' ? cell.source.group : 'legacy-v1';
}
function splitOf(cell: CellView): string {
  return cell.source?.kind === 'workflow' ? cell.source.split : cell.split;
}
export function reportGroups(report: PublishedReport): readonly {
  readonly name: string;
  readonly file: string;
  readonly cells: readonly CellView[];
}[] {
  const groups = new Map<string, CellView[]>();
  for (const cell of report.examples) {
    const key = JSON.stringify([splitOf(cell), groupOf(cell)]);
    const rows = groups.get(key) ?? [];
    rows.push(cell);
    groups.set(key, rows);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, cells]) => {
      const first = cells[0];
      if (first === undefined) throw new Error('empty report group');
      return {
        name: `${splitOf(first)}/${groupOf(first)}`,
        file: `${encodeURIComponent(key)}.md`,
        cells,
      };
    });
}

export function detailsIndex(
  report: PublishedReport,
  detailDirectory: string,
): string {
  return [
    heading(2, '全部分组明细'),
    '',
    ...reportGroups(report).map(
      (group) =>
        `- [${group.name.replaceAll('[', '\\[').replaceAll(']', '\\]')}](${encodeURIComponent(detailDirectory)}/${encodeURIComponent(group.file)})：${String(group.cells.length)} 个计划格子。`,
    ),
    '',
  ].join('\n');
}

export function renderDetails(
  report: PublishedReport,
): ReadonlyMap<string, string> {
  const persisted = new Map(
    report.publication?.consistency.cells.map((cell) => [cell.cellId, cell]),
  );
  return new Map(
    reportGroups(report).map((group) => [
      group.file,
      [
        heading(1, `分组明细 ${group.name}`),
        '',
        '覆盖本组全部计划格子；索引与持久化记录分别列明，不将技术失败当成拒绝，也不将生成成功当质量通过。工件位置仅为本机证据；缺记录不会生成伪附件链接。',
        '',
        row([
          'cell',
          'root/point/view',
          'target/协议/repeat',
          '参考来源/期望配对/行为',
          '实际配对/行为',
          '索引状态',
          '记录状态',
          '分类',
          '一致性',
          '简短理由',
          '本机记录/定位限制',
        ]),
        separator(11),
        ...group.cells.map((cell) => {
          const saved = persisted.get(cell.cellId);
          const source = cell.source;
          const identity =
            source?.kind === 'workflow'
              ? `${source.rootId}/${source.pointId}/${source.viewId}`
              : cell.caseId;
          const reference = cell.evaluationReference;
          return row([
            cell.cellId,
            identity,
            `${cell.targetId}/${cell.protocol}/r${String(cell.repeat)}`,
            `${reference?.source ?? '未知'} / ${JSON.stringify(reference?.target?.allowedPairs ?? reference?.target?.allowed ?? null)} / ${cell.reference ?? '未知'}`,
            `${String(cell.engine.risk ?? '未知')}/${String(cell.engine.authorization ?? '未知')} / ${cell.engine.word ?? '未判定'}`,
            saved?.indexStatus ?? cell.status,
            saved?.recordStatus ?? '无记录',
            cell.classification,
            saved?.reason ?? '一致',
            compactText(cell.rationale ?? cell.engine.reason),
            saved?.recordPath ?? '没有已保存记录；见原索引。',
          ]);
        }),
        '',
      ].join('\n'),
    ]),
  );
}

export function detailDirectoryOf(prefix: string): string {
  return `${basename(prefix)}.details`;
}
