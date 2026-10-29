/**
 * The Markdown rendering of a report.
 *
 * Markdown is the format a person reads and a pull request carries, so it holds the whole
 * document rather than a summary of the other two: the three layers, the denominators,
 * the differences and the per-example table all appear here. A reader with only this file
 * should be able to reconstruct why every headline number is what it is.
 *
 * Two rules follow from the report's own contract:
 *
 *   - a null rate prints as `n/a` with its denominator, never as `0%`. The document is
 *     built from the same figures the JSON holds, so the two cannot disagree about
 *     whether something was measured.
 *   - prose is Chinese, because the report is read by the person who owns the labels.
 *     Values the artifact recorded — ids, model names, verdicts, reasons — stay exactly
 *     as recorded and are never translated.
 *
 * The sections live in their own modules, so the composition here is the document's
 * outline and nothing else.
 */

import type { EvaluationReport } from '../metrics/types.js';
import { heading } from './format.js';
import { behaviourSection } from './sections-behaviour.js';
import { diagnosticsSection } from './sections-diagnostics.js';
import {
  closingSection,
  coverageSection,
  identitySection,
} from './sections-run.js';
import { settlementSection } from './sections-settlement.js';
import {
  comparisonSection,
  differencesSection,
  efficiencySection,
  examplesSection,
  stabilitySection,
} from './sections-support.js';
import { usageSection } from './sections-usage.js';

/**
 * Render one report as Markdown.
 *
 * The sections come in the order a reader needs them: what ran and what it covered, what
 * it did, why, what the host settled, what it cost, what may be compared, where it
 * differed, and the per-cell evidence behind all of it.
 */
export function renderMarkdown(report: EvaluationReport): string {
  return [
    heading(1, `评测报告 ${report.run.runId}`),
    '',
    '本报告由保存的运行记录离线重建：不新增请求、不覆盖证据、不回写任何标签。三层分开报告——主要自动行为指标、R/A 诊断、实际模式与宿主结算——技术失败不当成禁止。',
    '',
    identitySection(report),
    coverageSection(report),
    behaviourSection(report),
    diagnosticsSection(report),
    settlementSection(report),
    usageSection(report),
    stabilitySection(report),
    efficiencySection(report),
    comparisonSection(report),
    differencesSection(report),
    examplesSection(report),
    closingSection(report),
  ].join('\n');
}
