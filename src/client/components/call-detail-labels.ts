/**
 * Display labels for protocol values shown in the call detail.
 *
 * A verdict, stage name or execution status is a stable stored value; this module
 * only chooses the localized *label* for it. The value itself is never rewritten,
 * and an unrecognized value is displayed as-is so a newer record is still
 * readable instead of being hidden behind a missing translation.
 */

import type { Translate } from '../i18n.js';

/** The locale key for each stored verdict, when this build has a wording. */
const VERDICT_KEYS: Readonly<Record<string, string>> = {
  allow: 'callDetail.verdict.allow',
  deny: 'callDetail.verdict.deny',
  'force-ask': 'callDetail.verdict.forceAsk',
  'force-review': 'callDetail.verdict.forceReview',
  'review-allow': 'callDetail.verdict.reviewAllow',
  'review-deny': 'callDetail.verdict.reviewDeny',
  'review-escalate': 'callDetail.verdict.reviewEscalate',
  'human-allow': 'callDetail.verdict.humanAllow',
  'human-deny': 'callDetail.verdict.humanDeny',
  'human-abort': 'callDetail.verdict.humanAbort',
  'fallback-deny': 'callDetail.verdict.fallbackDeny',
  'error-escalate': 'callDetail.verdict.errorEscalate',
};

/** The locale key for each stored stage name. */
const STAGE_KEYS: Readonly<Record<string, string>> = {
  rule: 'callDetail.stage.rule',
  review: 'callDetail.stage.review',
  human: 'callDetail.stage.human',
  fallback: 'callDetail.stage.fallback',
};

/** The locale key for each host execution status. */
const EXECUTION_KEYS: Readonly<Record<string, string>> = {
  pending: 'callDetail.executionStatus.pending',
  success: 'callDetail.executionStatus.success',
  failed: 'callDetail.executionStatus.failed',
  'not-started': 'callDetail.executionStatus.notStarted',
  cancelled: 'callDetail.executionStatus.cancelled',
  timeout: 'callDetail.executionStatus.timeout',
};

/**
 * Translate a label when this build has one.
 *
 * The host locale returns the key itself when no translation exists, so that is
 * the signal to fall back to the raw stored value rather than expose the key.
 */
export function labelOf(
  t: Translate,
  keys: Readonly<Record<string, string>>,
  value: string,
): string {
  const key = keys[value];
  if (key === undefined) return value;
  const translated = t(key);
  return translated === key ? value : translated;
}

export function verdictLabel(t: Translate, verdict: string): string {
  return labelOf(t, VERDICT_KEYS, verdict);
}

export function stageLabel(t: Translate, stage: string): string {
  return labelOf(t, STAGE_KEYS, stage);
}

export function executionLabel(t: Translate, status: string): string {
  return labelOf(t, EXECUTION_KEYS, status);
}

/** The locale key for each missing-part code this build can explain. */
const MISSING_KEYS: Readonly<Record<string, string>> = {
  'audit-disabled': 'callDetail.missing.auditDisabled',
  'audit-unavailable': 'callDetail.missing.auditUnavailable',
  'audit-record-cleared': 'callDetail.missing.auditRecordCleared',
  'audit-unreadable': 'callDetail.missing.auditUnreadable',
  'record-format-newer': 'callDetail.missing.recordFormatNewer',
  'session-record-missing': 'callDetail.missing.sessionRecordMissing',
  'snapshot-missing': 'callDetail.missing.snapshotMissing',
  'snapshot-unreadable': 'callDetail.missing.snapshotUnreadable',
  'config-missing': 'callDetail.missing.configMissing',
  'config-unreadable': 'callDetail.missing.configUnreadable',
  'model-attempts-missing': 'callDetail.missing.modelAttemptsMissing',
  'template-missing': 'callDetail.missing.templateMissing',
  'template-unreadable': 'callDetail.missing.templateUnreadable',
  'stages-missing': 'callDetail.missing.stagesMissing',
  'stage-details-missing': 'callDetail.missing.stageDetailsMissing',
  'rule-name-missing': 'callDetail.missing.ruleNameMissing',
  'arguments-missing': 'callDetail.missing.argumentsMissing',
  'execution-not-observed': 'callDetail.missing.executionNotObserved',
  'history-unavailable': 'callDetail.missing.historyUnavailable',
};

/** A missing-part code as a sentence, or `null` for a code this build lacks. */
export function missingLabel(t: Translate, code: string): string | null {
  const key = MISSING_KEYS[code];
  if (key === undefined) return null;
  const translated = t(key);
  return translated === key ? null : translated;
}
