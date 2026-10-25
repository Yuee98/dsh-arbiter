import type { LogAnchor, LogDetail, LogPage, LogRow } from '../view-types.js';
import {
  array,
  boolean,
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
  return {
    ok: field(source, 'ok', boolean),
    rows: field(source, 'rows', array(logRow)),
    total: field(source, 'total', number),
    limit: field(source, 'limit', optional(number)) ?? LOG_PAGE_SIZE,
    // A page with no row has no cursor to continue from, so absence and null
    // mean the same thing here; the pager checks the row count as well.
    nextCursor: field(source, 'nextCursor', optional(anchor)) ?? null,
    prevCursor: field(source, 'prevCursor', optional(anchor)) ?? null,
    anchor: field(source, 'anchor', optional(anchor)) ?? null,
    newer: field(source, 'newer', optional(number)) ?? 0,
    code: field(source, 'code', optional(text)),
  };
}

function modelCall(value: unknown): LogDetail['modelCalls'][number] {
  const source = object(value);
  return {
    requestId: field(source, 'requestId', text),
    attempt: field(source, 'attempt', number),
    backend: field(source, 'backend', text),
    protocol: field(source, 'protocol', text),
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

function stage(value: unknown): LogDetail['stages'][number] {
  const source = object(value);
  return {
    seq: field(source, 'seq', number),
    stage: field(source, 'stage', text),
    result: field(source, 'result', text),
    reason: field(source, 'reason', nullable(text)),
    ruleId: field(source, 'ruleId', nullable(text)),
    decisionRules: field(source, 'decisionRules', strings),
    configRevision: field(source, 'configRevision', nullable(text)),
    ts: field(source, 'ts', number),
  };
}

function logDetail(value: unknown): LogDetail {
  const source = object(value);
  return {
    callId: field(source, 'callId', text),
    ts: field(source, 'ts', number),
    sessionId: field(source, 'sessionId', text),
    sessionKind: field(source, 'sessionKind', text),
    parentSession: field(source, 'parentSession', nullable(text)),
    tool: field(source, 'tool', text),
    arguments: field(source, 'arguments', unknownValue),
    cwd: field(source, 'cwd', text),
    fingerprint: field(source, 'fingerprint', text),
    configRevision: field(source, 'configRevision', text),
    approvalMode: field(source, 'approvalMode', text),
    executionMode: field(source, 'executionMode', text),
    result: field(source, 'result', text),
    reason: field(source, 'reason', text),
    trace: field(source, 'trace', array(unknownValue)),
    effect: field(source, 'effect', unknownValue),
    sessionRecordState: field(source, 'sessionRecordState', text),
    signals: field(source, 'signals', unknownValue),
    policyStrategy: field(source, 'policyStrategy', nullable(text)),
    decisionRules: field(source, 'decisionRules', strings),
    executionStatus: field(source, 'executionStatus', text),
    stages: field(source, 'stages', array(stage)),
    snapshot: field(source, 'snapshot', unknownValue),
    modelCalls: field(source, 'modelCalls', array(modelCall)),
    config: field(source, 'config', unknownValue),
  };
}

export function logResponse(value: unknown) {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    record: field(source, 'record', logDetail),
  };
}
