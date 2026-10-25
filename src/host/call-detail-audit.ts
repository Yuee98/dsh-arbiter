/**
 * Project one stored audit call into the shared detail contract.
 *
 * Every value here comes from the row the decision actually wrote, so a later
 * configuration change cannot relabel it. Where a column is absent (a v1 row, a
 * cleared snapshot, a newer record format) the field stays `null` and the reason
 * is reported as a missing code — never defaulted into a plausible-looking
 * claim.
 */

import type { StoredCall } from '../audit.js';
import { reviewedRequest } from './call-detail-transport.js';
import { snapshotBasis } from './call-detail-snapshot.js';
import { reviewStateOf } from './call-detail-trace.js';
import type {
  CallDetail,
  CallDetailBasis,
  CallDetailReviewState,
  CallDetailMissingCode,
  CallDetailModelAttempt,
  CallDetailRaw,
  CallDetailStage,
} from './call-detail-types.js';

/** A stored non-empty string, or `null` when the field is absent. */
function textOf(record: StoredCall, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOf(record: StoredCall, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whether a stored marker holds the boolean `true` (not `"true"`, not `1`). */
function isTrue(value: unknown): boolean {
  return value === true;
}

function isRecordLike(value: unknown): value is StoredCall {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(record: StoredCall, key: string): readonly StoredCall[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.filter(isRecordLike);
}

function stringsOf(record: StoredCall, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.filter((entry): entry is string => typeof entry === 'string');
}

/** Unknown members of a stored object, for values kept as raw evidence. */
function valueOf(record: StoredCall, key: string): unknown {
  return record[key] ?? null;
}

/** A stored string field, or `null` when it is absent. */
function storedText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One stored stage row as the detail presents it. */
function stageOf(stage: StoredCall, index: number): CallDetailStage {
  return {
    seq: numberOf(stage, 'seq') ?? index,
    stage: textOf(stage, 'stage') ?? 'unknown',
    result: textOf(stage, 'result') ?? 'unknown',
    reason: textOf(stage, 'reason'),
    ruleId: textOf(stage, 'ruleId'),
    ruleName: textOf(stage, 'ruleName'),
    decisionRules: stringsOf(stage, 'decisionRules'),
    configRevision: textOf(stage, 'configRevision'),
    configSnapshotId: textOf(stage, 'configSnapshotId'),
    ts: numberOf(stage, 'ts'),
  };
}

/** The stored result sequence, which every record carries. */
function traceOf(record: StoredCall): readonly string[] {
  const trace = record['trace'];
  if (!Array.isArray(trace)) return [];
  const items: readonly unknown[] = trace;
  return items.flatMap((item) => {
    if (!isRecordLike(item)) return [];
    const result: unknown = item['result'];
    return typeof result === 'string' ? [result] : [];
  });
}

/** One stored model attempt, with credentials removed from its material. */
function attemptOf(model: StoredCall): CallDetailModelAttempt {
  return {
    requestId: textOf(model, 'requestId') ?? '',
    attempt: numberOf(model, 'attempt') ?? 0,
    backend: textOf(model, 'backend') ?? '',
    protocol: textOf(model, 'protocol') ?? '',
    templateId: textOf(model, 'templateId'),
    // Only the transport block is removed; the reviewed content is stored
    // evidence and is shown as it is.
    request: reviewedRequest(valueOf(model, 'request')),
    responseText: storedText(model['responseText']),
    parsed: valueOf(model, 'parsed'),
    error: storedText(model['error']),
    startedAt: numberOf(model, 'startedAt') ?? 0,
    durationMs: numberOf(model, 'durationMs') ?? 0,
    estimatedInputTokens: numberOf(model, 'estimatedInputTokens') ?? 0,
    usage: valueOf(model, 'usage'),
  };
}

/** The rule that decided the call, using only the stored stage's own name. */
function ruleBasis(chain: readonly CallDetailStage[]): {
  readonly rule: CallDetailBasis['rule'];
  readonly missing: CallDetailMissingCode | null;
} {
  const stage = chain.find((entry) => entry.ruleId !== null);
  if (stage === undefined || stage.ruleId === null)
    return { rule: null, missing: null };
  return {
    rule: { ruleId: stage.ruleId, ruleName: stage.ruleName },
    missing: stage.ruleName === null ? 'rule-name-missing' : null,
  };
}

/** Whether a human approval ended without granting or denying. */
function isCancelled(chain: readonly CallDetailStage[] | null): boolean {
  if (chain === null) return false;
  return chain.some(
    (stage) =>
      stage.result === 'human-abort' || stage.reason === 'approval_cancelled',
  );
}

/** Material the row's own evidence says is absent or uninterpretable. */
function materialMissing(options: {
  readonly record: StoredCall;
  readonly snapshot: unknown;
  readonly config: unknown;
  readonly snapshotUnreadable: boolean;
  readonly configUnreadable: boolean;
  readonly attempts: readonly CallDetailModelAttempt[];
  readonly templates: readonly StoredCall[];
  readonly trace: readonly string[];
  readonly reviewState: CallDetailReviewState;
}): CallDetailMissingCode[] {
  const missing: CallDetailMissingCode[] = [];
  const { reviewState } = options;
  // A rule short-circuit never asked the model, so its absent snapshot and
  // attempts are not missing material. Reporting them would describe a gap the
  // record never had, and would imply a review this call did not receive.
  if (reviewState === 'reviewed' && options.snapshotUnreadable)
    missing.push('snapshot-unreadable');
  else if (reviewState === 'reviewed' && options.snapshot === null)
    missing.push('snapshot-missing');
  // Every call is decided under some configuration snapshot, so a missing row
  // for it is a genuine gap even when the call never reached a model review.
  if (options.configUnreadable) missing.push('config-unreadable');
  else if (options.config === null) missing.push('config-missing');
  // `arguments` arrives already parsed from the stored JSON, so absence is a
  // null value rather than an empty string.
  if (valueOf(options.record, 'arguments') === null)
    missing.push('arguments-missing');
  if (reviewState === 'reviewed' && options.attempts.length === 0)
    missing.push('model-attempts-missing');
  missing.push(...templateMissing(options.attempts, options.templates));
  if (textOf(options.record, 'executionStatus') === 'pending')
    missing.push('execution-not-observed');
  return [...new Set(missing)];
}

/** Template references whose content is missing or cannot be read. */
function templateMissing(
  attempts: readonly CallDetailModelAttempt[],
  templates: readonly StoredCall[],
): readonly CallDetailMissingCode[] {
  return attempts.flatMap((attempt) => {
    if (attempt.templateId === null) return [];
    const stored = templates.find(
      (template) => textOf(template, 'templateId') === attempt.templateId,
    );
    // No entry, or an entry that records no row, both mean the referenced
    // template is missing — not that it exists with empty content.
    if (stored === undefined || stored['present'] === false)
      return ['template-missing'];
    return isTrue(stored['unreadable']) ? ['template-unreadable'] : [];
  });
}

/** The raw layer of an interpretable record. */
function rawOf(
  record: StoredCall,
  options: {
    readonly snapshot: unknown;
    readonly config: unknown;
    readonly attempts: readonly CallDetailModelAttempt[];
    readonly templates: readonly StoredCall[];
  },
): CallDetailRaw {
  return {
    arguments: valueOf(record, 'arguments'),
    argumentsSchema: valueOf(record, 'argumentsSchema'),
    snapshot: options.snapshot,
    config: options.config,
    configFormatVersion: numberOf(record, 'configFormatVersion'),
    snapshotFormatVersion: numberOf(record, 'snapshotFormatVersion'),
    modelAttempts: options.attempts,
    templates: options.templates,
    sessionRecordState: textOf(record, 'sessionRecordState'),
  };
}

/**
 * A record this build cannot interpret.
 *
 * Its identity is still real — the call happened — but its shape is not guessed
 * at: only the identifying fields are shown, and the reason is reported as a
 * missing code so the operator knows why the layers are absent.
 */
function unreadableDetail(record: StoredCall): CallDetail {
  return {
    callId: textOf(record, 'callId') ?? '',
    source: 'audit',
    recordFormatVersion: numberOf(record, 'recordFormatVersion'),
    unreadable: true,
    unreadableReason: textOf(record, 'unreadableReason'),
    overview: {
      tool: textOf(record, 'tool') ?? '',
      ts: numberOf(record, 'ts') ?? 0,
      sessionId: textOf(record, 'sessionId'),
      sessionKind: textOf(record, 'sessionKind'),
      parentSession: null,
      workspace: null,
      cwd: null,
      profile: null,
      approvalMode: null,
      executionMode: null,
      verdict: null,
      verdictReason: null,
      configRevision: null,
      fingerprint: null,
      execution: { status: null, startedAt: null, finishedAt: null },
      cancelled: false,
    },
    basis: {
      rule: null,
      decisionRules: [],
      conflicts: [],
      conflictsTruncated: false,
      policyStrategy: null,
      chain: null,
      reviewState: 'unknown',
      trace: [],
      signals: null,
      evidence: [],
      materials: [],
      evidenceTruncated: false,
      snapshotMissing: [],
      historyStatus: null,
      effect: null,
    },
    raw: {
      arguments: null,
      argumentsSchema: null,
      snapshot: null,
      config: null,
      configFormatVersion: null,
      snapshotFormatVersion: null,
      modelAttempts: [],
      templates: [],
      sessionRecordState: null,
    },
    missing: ['record-format-newer'],
  };
}

/** Read one stored call as the shared detail; never throws on old data. */
export function auditDetail(record: StoredCall): CallDetail {
  if (record.unreadable) return unreadableDetail(record);
  const stages = recordsOf(record, 'stages');
  const chain = stages.length === 0 ? null : stages.map(stageOf);
  const trace = traceOf(record);
  const snapshotUnreadable = isTrue(record['snapshotUnreadable']);
  const configUnreadable = isTrue(record['configUnreadable']);
  const snapshot = snapshotUnreadable ? null : valueOf(record, 'snapshot');
  const config = configUnreadable ? null : valueOf(record, 'config');
  const attempts = recordsOf(record, 'modelCalls').map(attemptOf);
  const templates = recordsOf(record, 'templates');
  const basis = snapshotBasis(snapshot);
  const rule = ruleBasis(chain ?? []);
  const missing: CallDetailMissingCode[] = [
    ...materialMissing({
      record,
      snapshot,
      config,
      snapshotUnreadable,
      configUnreadable,
      attempts,
      templates,
      trace,
      reviewState: reviewStateOf(trace, chain ?? null),
    }),
    ...(rule.missing === null ? [] : [rule.missing]),
    // No structured chain: either the source kept result strings only, or it
    // kept nothing at all. Those are different answers, so they are named
    // differently rather than collapsed into "no stages".
    ...(chain === null && trace.length > 0
      ? (['stage-details-missing'] as const)
      : []),
    ...(chain === null && trace.length === 0
      ? (['stages-missing'] as const)
      : []),
  ];
  return {
    callId: textOf(record, 'callId') ?? '',
    source: 'audit',
    recordFormatVersion: numberOf(record, 'recordFormatVersion'),
    unreadable: false,
    unreadableReason: null,
    overview: {
      tool: textOf(record, 'tool') ?? '',
      ts: numberOf(record, 'ts') ?? 0,
      sessionId: textOf(record, 'sessionId'),
      sessionKind: textOf(record, 'sessionKind'),
      parentSession: textOf(record, 'parentSession'),
      workspace: textOf(record, 'workspace'),
      cwd: textOf(record, 'cwd'),
      profile: textOf(record, 'profile'),
      approvalMode: textOf(record, 'approvalMode'),
      executionMode: textOf(record, 'executionMode'),
      verdict: textOf(record, 'result'),
      verdictReason: textOf(record, 'reason'),
      configRevision: textOf(record, 'configRevision'),
      fingerprint: textOf(record, 'fingerprint'),
      execution: {
        status: textOf(record, 'executionStatus'),
        startedAt: numberOf(record, 'executionStartedAt'),
        finishedAt: numberOf(record, 'executionFinishedAt'),
      },
      cancelled: isCancelled(chain),
    },
    basis: {
      rule: rule.rule,
      decisionRules: stringsOf(record, 'decisionRules'),
      // An audit row is one observation written by one settlement; the store has
      // no second reading of it to disagree with.
      conflicts: [],
      conflictsTruncated: false,
      policyStrategy: textOf(record, 'policyStrategy'),
      chain,
      reviewState: reviewStateOf(trace, chain),
      trace,
      signals: valueOf(record, 'signals'),
      evidence: basis.evidence,
      materials: basis.materials,
      evidenceTruncated: basis.evidenceTruncated,
      snapshotMissing: basis.missing,
      historyStatus: basis.historyStatus,
      effect: valueOf(record, 'effect'),
    },
    raw: rawOf(record, { snapshot, config, attempts, templates }),
    missing: [...new Set(missing)],
  };
}
