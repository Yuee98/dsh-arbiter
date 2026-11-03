import type { PublishedReport } from './publication-types.js';
import { heading, row, separator } from './format.js';

export function publicationSection(report: PublishedReport): string {
  const pub = report.publication;
  if (pub === undefined) return '';
  const code = pub.testedCode;
  return [
    heading(2, '被测来源与归档'),
    '',
    row(['项目', '实际记录']),
    separator(2),
    row(['被测代码 commit', code.revision ?? '未知（不回填当前 HEAD）']),
    row([
      '被测工作区 dirty',
      code.dirty === null ? '未知' : String(code.dirty),
    ]),
    row(['来源说明', code.reason ?? '原运行记录']),
    row(['数据源 commit', pub.testedSource.revision ?? '未知']),
    row(['原运行位置（本机）', pub.runDirectory]),
    row(['完整配置/范围（本机原工件）', pub.planPath]),
    row(['原索引（本机）', pub.indexPath]),
    row(['报告所选数据源（本机）', pub.datasetPath ?? '未读取数据源']),
    row(['所选范围', JSON.stringify(pub.scope)]),
    row(['实际输入预算', JSON.stringify(pub.context)]),
    row(['显式参考快照（本机）', pub.references.join('；') || '未提供']),
    row(['生成阶段', pub.generation]),
    row(['质量验收', pub.qualityAcceptance.status]),
    row(['质量说明', pub.qualityAcceptance.reason]),
    row([
      '索引完成状态可信',
      pub.consistency.indexReliable
        ? '是'
        : '否：索引与持久化记录不一致，见各组逐格状态',
    ]),
    '',
    '这里的工件路径仅指向本机副本，未声明为 GitHub 可访问附件。提交报告的 commit 由 Git 历史定位，与上方被测 commit 分开；报告不会自动提交，也不会把后来 HEAD 冒充被测版本。',
    '同工件、同配置与位置可离线重建。仅展示变更可按实际 diff 复用结果；模型、prompt、输入或预算变化需要对应新证据。没有正式阈值时不宣布质量通过。',
    '',
  ].join('\n');
}
