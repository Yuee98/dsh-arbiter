import type { ConfigIssueView } from '../view-issues.js';
import type {
  AuditHealthView,
  AuditStats,
  SaveResponse,
  StateResponse,
} from '../view-types.js';
import { configuration } from './config.js';
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

const issueParams = (
  value: unknown,
): Readonly<Record<string, string | number>> => {
  if (value === undefined) return {};
  const source = object(value);
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, entry]) => {
      if (typeof entry === 'string' || typeof entry === 'number')
        return [[key, entry] as const];
      if (typeof entry === 'boolean') return [[key, String(entry)] as const];
      return [];
    }),
  );
};

/** A localized sentence is selected by `code`; `message` stays the fallback. */
export function configIssue(value: unknown): ConfigIssueView {
  const source = object(value);
  return {
    path: field(source, 'path', text),
    message: field(source, 'message', text),
    code: field(source, 'code', optional(text)) ?? 'config.unknown',
    params: field(source, 'params', optional(issueParams)) ?? {},
  };
}

export function validationResponse(value: unknown) {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    errors: field(source, 'errors', array(configIssue)),
    warnings: field(source, 'warnings', array(configIssue)),
  };
}

export function saveResponse(value: unknown): SaveResponse {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    saved: field(source, 'saved', boolean),
    changed: field(source, 'changed', boolean),
    effective: field(source, 'effective', boolean),
    effectiveRevision: field(source, 'effectiveRevision', text),
    configSnapshotId: field(source, 'configSnapshotId', text),
    activationRecorded: field(source, 'activationRecorded', boolean),
    configFormat: field(source, 'configFormat', text),
    configFormatExplicit: field(source, 'configFormatExplicit', boolean),
    auditError: field(source, 'auditError', nullable(text)),
    warnings: field(source, 'warnings', array(configIssue)),
  };
}

function auditHealth(value: unknown): AuditHealthView {
  const source = object(value);
  return {
    state: field(
      source,
      'state',
      choice('ok', 'degraded', 'unavailable', 'disabled'),
    ),
    lastError: field(source, 'lastError', nullable(text)),
    dropped: field(source, 'dropped', number),
    pending: field(source, 'pending', number),
  };
}

function auditStats(value: unknown): AuditStats {
  const source = object(value);
  return {
    calls: field(source, 'calls', number),
    modelCalls: field(source, 'modelCalls', number),
    bytes: field(source, 'bytes', number),
    results: field(
      source,
      'results',
      array((item) => {
        const result = object(item);
        return {
          result: field(result, 'result', text),
          count: field(result, 'count', number),
        };
      }),
    ),
  };
}

function recordError(value: unknown): readonly [string, string] {
  const values = strings(value);
  if (values.length !== 2 || values[0] === undefined || values[1] === undefined)
    throw new TypeError('expected a session id and error message pair');
  return [values[0], values[1]];
}

export function stateResponse(value: unknown): StateResponse {
  const source = object(value);
  const audit = field(source, 'audit', object);
  const coverage = field(source, 'coverage', object);
  const modes = field(source, 'modes', object);
  return {
    name: field(source, 'name', text),
    enabled: field(source, 'enabled', boolean),
    config: field(source, 'config', configuration),
    sourceConfig: field(source, 'sourceConfig', unknownValue),
    effectiveRevision: field(source, 'effectiveRevision', text),
    configSnapshotId: field(source, 'configSnapshotId', text),
    configFormat: field(source, 'configFormat', text),
    configFormatExplicit: field(source, 'configFormatExplicit', boolean),
    fileRevision: field(source, 'fileRevision', nullable(text)),
    documentPath: field(source, 'documentPath', nullable(text)),
    invalidConfigError: field(source, 'invalidConfigError', nullable(text)),
    loadErrors: field(source, 'loadErrors', array(configIssue)),
    warnings: field(source, 'warnings', array(configIssue)),
    autoPresetError: field(source, 'autoPresetError', nullable(text)),
    configHistoryComplete: field(source, 'configHistoryComplete', boolean),
    configHistory: field(
      source,
      'configHistory',
      array((item) => {
        const activation = object(item);
        return {
          id: field(activation, 'id', text),
          activatedAt: field(activation, 'activatedAt', number),
          revision: field(activation, 'revision', text),
          entry: field(activation, 'entry', text),
          scope: field(activation, 'scope', text),
          snapshotId: field(activation, 'snapshotId', text),
        };
      }),
    ),
    audit: {
      health: field(audit, 'health', auditHealth),
      path: field(audit, 'path', nullable(text)),
      bytes: field(audit, 'bytes', number),
      stats: field(audit, 'stats', nullable(auditStats)),
    },
    coverage: {
      gated: field(coverage, 'gated', strings),
      notGated: field(coverage, 'notGated', strings),
    },
    policyVersion: field(source, 'policyVersion', text),
    modes: {
      main: field(modes, 'main', text),
      subagent: field(modes, 'subagent', text),
    },
    executionMode: field(source, 'executionMode', text),
    reviewerType: field(source, 'reviewerType', text),
    sessionRecordErrors: field(
      source,
      'sessionRecordErrors',
      array(recordError),
    ),
  };
}
