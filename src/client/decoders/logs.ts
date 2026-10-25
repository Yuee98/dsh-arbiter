import type { LogDetail, LogRow } from '../view-types.js';
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
    reason: field(source, 'reason', text),
    ruleId: field(source, 'ruleId', nullable(text)),
    approvalMode: field(source, 'approvalMode', text),
    decisionRules: field(source, 'decisionRules', strings),
  };
}

export function logsResponse(value: unknown) {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    rows: field(source, 'rows', array(logRow)),
    total: field(source, 'total', number),
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
