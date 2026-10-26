import type {
  CallDetailMissingCode,
  CallDetailModelAttemptView,
  CallDetailStageView,
  CallDetailView,
  LogAnchor,
  LogPage,
  LogRow,
} from '../view-types.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  optional,
  strings,
  text,
  unknownValue,
} from './values.js';

/** The page size the client asks for when it has no reason to ask otherwise. */
export const LOG_PAGE_SIZE = 25;

function logRow(value: unknown): LogRow {
  const source = object(value);
  return {
    callId: field(source, 'callId', text),
    ts: field(source, 'ts', number),
    sessionId: field(source, 'sessionId', text),
    sessionKind: field(source, 'sessionKind', text),
    tool: field(source, 'tool', text),
    command: field(source, 'command', text),
    result: field(source, 'result', text),
    ruleId: field(source, 'ruleId', nullable(text)),
    unreadable: field(source, 'unreadable', boolean),
  };
}

/**
 * One list page.
 *
 * `limit` and `offset` are decoded with a fallback rather than required: the
 * host echoes the window it actually read, and an older or unavailable store
 * answers without one. Falling back to the requested page keeps the pager
 * usable instead of failing the whole list over an advisory field.
 */
function anchor(value: unknown): LogAnchor | null {
  if (value === null) return null;
  const source = object(value);
  return {
    ts: field(source, 'ts', number),
    callId: field(source, 'callId', text),
  };
}

export function logsResponse(value: unknown): LogPage {
  const source = object(value);
  const rows = field(source, 'rows', array(logRow));
  return {
    ok: field(source, 'ok', boolean),
    rows,
    total: field(source, 'total', number),
    limit: field(source, 'limit', optional(number)) ?? LOG_PAGE_SIZE,
    // A page with no row has no cursor to continue from, so absence and null
    // mean the same thing here; the pager checks the row count as well.
    nextCursor: field(source, 'nextCursor', optional(anchor)) ?? null,
    prevCursor: field(source, 'prevCursor', optional(anchor)) ?? null,
    anchor: field(source, 'anchor', optional(anchor)) ?? null,
    newer: field(source, 'newer', optional(number)) ?? 0,
    // An older host that does not report continuation: fall back to "the page was
    // full", which is the most its window implies.
    remaining:
      field(source, 'remaining', optional(number)) ??
      (rows.length === LOG_PAGE_SIZE ? LOG_PAGE_SIZE : 0),
    code: field(source, 'code', optional(text)),
  };
}

const MISSING_CODES = [
  'audit-disabled',
  'audit-unavailable',
  'audit-record-cleared',
  'audit-unreadable',
  'record-format-newer',
  'snapshot-missing',
  'snapshot-unreadable',
  'config-missing',
  'config-unreadable',
  'model-attempts-missing',
  'template-missing',
  'template-unreadable',
  'stages-missing',
  'stage-details-missing',
  'rule-name-missing',
  'arguments-missing',
  'execution-not-observed',
] as const satisfies readonly CallDetailMissingCode[];

/**
 * One missing-part code, split into known and unrecognized.
 *
 * A known code renders its own sentence. An unrecognized one — a newer host
 * reporting a gap this build has no wording for — is counted so the page shows a
 * generic "material unavailable" sentence instead of publishing a raw token.
 */
function missingCodes(value: unknown): {
  readonly known: readonly CallDetailMissingCode[];
  readonly unknown: number;
} {
  const codes = strings(value);
  return {
    known: MISSING_CODES.filter((code) => codes.includes(code)),
    unknown: codes.filter(
      (code) => !MISSING_CODES.some((known) => known === code),
    ).length,
  };
}

function stage(value: unknown): CallDetailStageView {
  const source = object(value);
  return {
    seq: field(source, 'seq', number),
    stage: field(source, 'stage', text),
    result: field(source, 'result', text),
    reason: field(source, 'reason', nullable(text)),
    ruleId: field(source, 'ruleId', nullable(text)),
    ruleName: field(source, 'ruleName', nullable(text)),
    decisionRules: field(source, 'decisionRules', strings),
    configRevision: field(source, 'configRevision', nullable(text)),
    configSnapshotId: field(source, 'configSnapshotId', nullable(text)),
    ts: field(source, 'ts', nullable(number)),
  };
}

function attempt(value: unknown): CallDetailModelAttemptView {
  const source = object(value);
  return {
    requestId: field(source, 'requestId', text),
    attempt: field(source, 'attempt', number),
    backend: field(source, 'backend', text),
    protocol: field(source, 'protocol', text),
    templateId: field(source, 'templateId', nullable(text)),
    request: field(source, 'request', unknownValue),
    responseText: field(source, 'responseText', nullable(text)),
    parsed: field(source, 'parsed', unknownValue),
    error: field(source, 'error', nullable(text)),
    startedAt: field(source, 'startedAt', number),
    durationMs: field(source, 'durationMs', number),
    estimatedInputTokens: field(source, 'estimatedInputTokens', number),
    usage: field(source, 'usage', unknownValue),
  };
}

function ruleBasis(value: unknown): CallDetailView['basis']['rule'] {
  if (value === null) return null;
  const source = object(value);
  return {
    ruleId: field(source, 'ruleId', text),
    ruleName: field(source, 'ruleName', nullable(text)),
  };
}

function detail(value: unknown): CallDetailView {
  const source = object(value);
  const overview = field(source, 'overview', object);
  const execution = field(overview, 'execution', object);
  const basis = field(source, 'basis', object);
  const raw = field(source, 'raw', object);
  const missing = missingCodes(source['missing']);
  return {
    callId: field(source, 'callId', text),
    source: field(source, 'source', choice('audit', 'session')),
    recordFormatVersion: field(source, 'recordFormatVersion', nullable(number)),
    unreadable: field(source, 'unreadable', boolean),
    unreadableReason: field(source, 'unreadableReason', nullable(text)),
    overview: {
      tool: field(overview, 'tool', text),
      ts: field(overview, 'ts', number),
      sessionId: field(overview, 'sessionId', nullable(text)),
      sessionKind: field(overview, 'sessionKind', nullable(text)),
      parentSession: field(overview, 'parentSession', nullable(text)),
      workspace: field(overview, 'workspace', nullable(text)),
      cwd: field(overview, 'cwd', nullable(text)),
      profile: field(overview, 'profile', nullable(text)),
      approvalMode: field(overview, 'approvalMode', nullable(text)),
      executionMode: field(overview, 'executionMode', nullable(text)),
      verdict: field(overview, 'verdict', nullable(text)),
      verdictReason: field(overview, 'verdictReason', nullable(text)),
      configRevision: field(overview, 'configRevision', nullable(text)),
      fingerprint: field(overview, 'fingerprint', nullable(text)),
      execution: {
        status: field(execution, 'status', nullable(text)),
        startedAt: field(execution, 'startedAt', nullable(number)),
        finishedAt: field(execution, 'finishedAt', nullable(number)),
      },
      cancelled: field(overview, 'cancelled', boolean),
    },
    basis: {
      rule: ruleBasis(field(basis, 'rule', unknownValue)),
      decisionRules: field(basis, 'decisionRules', strings),
      conflicts: field(
        basis,
        'conflicts',
        array((item) => {
          const conflict = object(item);
          return {
            field: field(conflict, 'field', text),
            observed: field(conflict, 'observed', strings),
          };
        }),
      ),
      conflictsTruncated: field(basis, 'conflictsTruncated', boolean),
      policyStrategy: field(basis, 'policyStrategy', nullable(text)),
      chain: field(basis, 'chain', nullable(array(stage))),
      reviewState: field(
        basis,
        'reviewState',
        choice('none', 'reviewed', 'unknown'),
      ),
      trace: field(basis, 'trace', strings),
      signals: field(basis, 'signals', unknownValue),
      evidence: field(basis, 'evidence', array(unknownValue)),
      materials: field(basis, 'materials', array(unknownValue)),
      evidenceTruncated: field(basis, 'evidenceTruncated', boolean),
      snapshotMissing: field(basis, 'snapshotMissing', strings),
      historyStatus: field(basis, 'historyStatus', unknownValue),
      effect: field(basis, 'effect', unknownValue),
    },
    raw: {
      arguments: field(raw, 'arguments', unknownValue),
      argumentsSchema: field(raw, 'argumentsSchema', unknownValue),
      snapshot: field(raw, 'snapshot', unknownValue),
      config: field(raw, 'config', unknownValue),
      configFormatVersion: field(raw, 'configFormatVersion', nullable(number)),
      snapshotFormatVersion: field(
        raw,
        'snapshotFormatVersion',
        nullable(number),
      ),
      modelAttempts: field(raw, 'modelAttempts', array(attempt)),
      templates: field(raw, 'templates', array(unknownValue)),
      sessionRecordState: field(raw, 'sessionRecordState', nullable(text)),
    },
    missing: missing.known,
    missingUnknown: missing.unknown,
  };
}

/**
 * The detail response body.
 *
 * "No record" and "unreadable structure" are HTTP error answers with their own
 * stable codes, so this decoder only ever accepts a real detail. A body that
 * claims success without one is rejected rather than rendered as an empty
 * detail, which would look like a call with every layer missing.
 */
export function callDetailResponse(value: unknown): CallDetailView {
  const source = object(value);
  if (!field(source, 'ok', boolean))
    throw new TypeError('the detail response is not ok');
  return field(source, 'detail', detail);
}
