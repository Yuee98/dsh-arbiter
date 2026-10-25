import type { ReviewSignals } from '../types.js';
import type {
  CallFilter,
  CallSummary,
  CandidateRecord,
  StoredCall,
} from './types.js';
import { READABLE_RECORD_FORMATS } from './schema.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  asRow,
  asRows,
  rowText,
  rowNumber,
  rowJson,
  rowStrings,
  rowTrace,
  rowSignals,
  isRecord,
  json,
} from './rows.js';
export function configHistory(
  db: DatabaseSync,
  limit = 20,
): readonly {
  readonly id: string;
  readonly activatedAt: number;
  readonly revision: string;
  readonly entry: string;
  readonly scope: string;
  readonly snapshotId: string;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT id, activated_at, revision, entry, scope, snapshot_id
           FROM config_activations
          ORDER BY activated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit),
  );
  return rows.map((row) => ({
    id: rowText(row['id']),
    activatedAt: rowNumber(row['activated_at']),
    revision: rowText(row['revision']),
    entry: rowText(row['entry']),
    scope: rowText(row['scope']),
    snapshotId: rowText(row['snapshot_id']),
  }));
}

/** The format a row was written with; a v1 database has no such column yet. */
function formatOf(row: Record<string, unknown>): number {
  const raw = row['record_format_version'];
  const value = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 1);
  return Number.isFinite(value) ? value : 1;
}

/**
 * Whether this build can interpret a stored record.
 *
 * An unknown (newer) format is not an error and not a reason to rewrite the
 * row: the caller can still show the identifying fields, and the operator is
 * told the record needs a newer plugin. Expressing that as a flag keeps the
 * read path total instead of throwing on data it did not write.
 */
function readableFormat(version: number): boolean {
  return READABLE_RECORD_FORMATS.includes(version);
}

/** An absolute timestamp, or null when the record never recorded one. */
function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The version marker every detail/list reader attaches.
 *
 * Absent columns stay `null`: a v1 row genuinely has no execution timestamps,
 * and reporting `0` would claim an execution that never happened.
 */
function versionFields(row: Record<string, unknown>): {
  readonly recordFormatVersion: number;
  readonly unreadable: boolean;
  readonly unreadableReason: string | null;
} {
  const version = formatOf(row);
  const readable = readableFormat(version);
  return {
    recordFormatVersion: version,
    unreadable: !readable,
    unreadableReason: readable
      ? null
      : `record format ${String(version)} is newer than this plugin (${String(Math.max(...READABLE_RECORD_FORMATS))})`,
  };
}

export function listCalls(
  db: DatabaseSync,
  filter: CallFilter = {},
): {
  readonly rows: CallSummary[];
  readonly total: number;
} {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (filter.result !== undefined && filter.result.length > 0) {
    clauses.push('result = ?');
    values.push(filter.result);
  }
  if (filter.tool !== undefined && filter.tool.length > 0) {
    clauses.push('tool = ?');
    values.push(filter.tool);
  }
  if (filter.sessionId !== undefined && filter.sessionId.length > 0) {
    clauses.push('session_id = ?');
    values.push(filter.sessionId);
  }
  if (filter.from !== undefined) {
    clauses.push('ts >= ?');
    values.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('ts <= ?');
    values.push(filter.to);
  }
  if (filter.query !== undefined && filter.query.length > 0) {
    clauses.push('(arguments LIKE ? OR reason LIKE ? OR tool LIKE ?)');
    const like = `%${filter.query}%`;
    values.push(like, like, like);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const totalRow = asRow(
    db.prepare(`SELECT COUNT(*) AS count FROM calls ${where}`).get(...values),
  );
  const total = rowNumber(totalRow['count']);
  const rows = asRows(
    db
      .prepare(
        `SELECT call_id, ts, session_id, session_kind, tool, arguments, result, reason, approval_mode, decision_rules,
                trace, record_format_version, execution_status, execution_started_at, execution_finished_at
           FROM calls ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset),
  );
  return {
    total,
    rows: rows.map((row) => {
      const args = rowJson(row['arguments']);
      const command = isRecord(args)
        ? typeof args['command'] === 'string'
          ? args['command']
          : typeof args['code'] === 'string'
            ? args['code']
            : json(args).slice(0, 240)
        : '';
      const trace = rowTrace(row['trace']);
      const rule = trace.find((stage) => stage.stage === 'rule');
      return {
        callId: rowText(row['call_id']),
        ts: rowNumber(row['ts']),
        sessionId: rowText(row['session_id']),
        sessionKind: rowText(row['session_kind'], 'main'),
        tool: rowText(row['tool']),
        command,
        result: rowText(row['result']),
        reason: rowText(row['reason']),
        ruleId: rule?.ruleId ?? null,
        // The historical name is carried with the row; it is not re-read from
        // whatever the rule list contains today.
        ruleName: rule?.ruleName ?? null,
        approvalMode: rowText(row['approval_mode']),
        decisionRules: rowStrings(row['decision_rules']),
        executionStatus: rowText(row['execution_status']),
        executionStartedAt: optionalNumber(row['execution_started_at']),
        executionFinishedAt: optionalNumber(row['execution_finished_at']),
        ...versionFields(row),
      };
    }),
  };
}

/** One stored stage row as the detail view presents it. */
function stageRow(stage: Record<string, unknown>): Record<string, unknown> {
  return {
    seq: rowNumber(stage['seq']),
    stage: rowText(stage['stage']),
    result: rowText(stage['result']),
    reason: typeof stage['reason'] === 'string' ? stage['reason'] : null,
    ruleId: typeof stage['rule_id'] === 'string' ? stage['rule_id'] : null,
    ruleName:
      typeof stage['rule_name'] === 'string' ? stage['rule_name'] : null,
    decisionRules: rowStrings(stage['decision_rules']),
    configRevision:
      typeof stage['config_revision'] === 'string'
        ? stage['config_revision']
        : null,
    configSnapshotId:
      typeof stage['config_snapshot_id'] === 'string'
        ? stage['config_snapshot_id']
        : null,
    ts: rowNumber(stage['ts']),
  };
}

/** One stored model attempt as the detail view presents it. */
function modelCallRow(model: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: rowText(model['id']),
    attempt: rowNumber(model['attempt']),
    backend: rowText(model['backend']),
    protocol: rowText(model['protocol']),
    request: rowJson(model['request']),
    responseText:
      typeof model['response_text'] === 'string'
        ? model['response_text']
        : null,
    parsed: rowJson(model['parsed']),
    error: typeof model['error'] === 'string' ? model['error'] : null,
    startedAt: rowNumber(model['started_at']),
    durationMs: rowNumber(model['duration_ms']),
    estimatedInputTokens: rowNumber(model['estimated_input_tokens']),
    usage: rowJson(model['usage']),
  };
}

export function getCall(db: DatabaseSync, callId: string): StoredCall | null {
  const callValue = db
    .prepare('SELECT * FROM calls WHERE call_id = ?')
    .get(callId);
  if (callValue === undefined) return null;
  const call = asRow(callValue);
  const stages = asRows(
    db
      .prepare('SELECT * FROM stages WHERE call_id = ? ORDER BY seq')
      .all(callId),
  );
  const snapshotValue = db
    .prepare('SELECT content FROM snapshots WHERE call_id = ?')
    .get(callId);
  const snapshot = asRow(snapshotValue);
  const models = asRows(
    db
      .prepare('SELECT * FROM model_calls WHERE call_id = ? ORDER BY attempt')
      .all(callId),
  );
  const configValue = db
    .prepare('SELECT content FROM config_snapshots WHERE snapshot_id = ?')
    .get(rowText(call['config_snapshot_id']));
  const config = asRow(configValue);
  const version = versionFields(call);
  // A record this build cannot interpret is returned with its raw identifying
  // fields and the marker; the adapter never guesses at the current shape.
  if (version.unreadable) {
    return {
      ...version,
      callId: rowText(call['call_id']),
      ts: rowNumber(call['ts']),
      tool: rowText(call['tool']),
      result: null,
      raw: Object.fromEntries(
        Object.entries(call).map(([key, value]) => [
          key,
          typeof value === 'bigint' ? Number(value) : value,
        ]),
      ),
    };
  }
  return {
    ...version,
    callId: rowText(call['call_id']),
    ts: rowNumber(call['ts']),
    sessionId: rowText(call['session_id']),
    sessionKind: rowText(call['session_kind'], 'main'),
    parentSession:
      typeof call['parent_session'] === 'string'
        ? call['parent_session']
        : null,
    profile: typeof call['profile'] === 'string' ? call['profile'] : null,
    workspace: typeof call['workspace'] === 'string' ? call['workspace'] : null,
    tool: rowText(call['tool']),
    arguments: rowJson(call['arguments']),
    // Absent stays null: a v1 row recorded no schema, and inventing one would
    // claim the host declared something it did not.
    argumentsSchema:
      typeof call['arguments_schema'] === 'string'
        ? rowJson(call['arguments_schema'])
        : null,
    cwd: rowText(call['cwd']),
    fingerprint: rowText(call['fingerprint']),
    configRevision: rowText(call['config_revision']),
    approvalMode: rowText(call['approval_mode']),
    executionMode: rowText(call['execution_mode']),
    result: rowText(call['result']),
    reason: rowText(call['reason']),
    trace: rowJson(call['trace']),
    effect: rowJson(call['effect']),
    sessionRecordState: rowText(call['session_record_state']),
    signals: rowJson(call['signals']),
    policyStrategy:
      typeof call['policy_strategy'] === 'string'
        ? call['policy_strategy']
        : null,
    decisionRules: rowStrings(call['decision_rules']),
    executionStatus: rowText(call['execution_status']),
    executionStartedAt: optionalNumber(call['execution_started_at']),
    executionFinishedAt: optionalNumber(call['execution_finished_at']),
    stages: stages.map(stageRow),
    snapshot: rowJson(snapshot['content']),
    modelCalls: models.map(modelCallRow),
    config: rowJson(config['content']),
  };
}

export function stats(db: DatabaseSync, databaseBytes: () => number): unknown {
  const rows = asRows(
    db
      .prepare(
        'SELECT result, COUNT(*) AS count FROM calls GROUP BY result ORDER BY count DESC',
      )
      .all(),
  );
  const rules = asRows(
    db
      .prepare(
        "SELECT result, COUNT(*) AS count FROM stages WHERE stage = 'review' GROUP BY result",
      )
      .all(),
  );
  const callCount = asRow(
    db.prepare('SELECT COUNT(*) AS count FROM calls').get(),
  );
  const modelCount = asRow(
    db.prepare('SELECT COUNT(*) AS count FROM model_calls').get(),
  );
  return {
    results: rows.map((row) => ({
      result: rowText(row['result']),
      count: rowNumber(row['count']),
    })),
    review: rules.map((row) => ({
      result: rowText(row['result']),
      count: rowNumber(row['count']),
    })),
    calls: rowNumber(callCount['count']),
    modelCalls: rowNumber(modelCount['count']),
    bytes: databaseBytes(),
  };
}

export function callsForAnalysis(
  db: DatabaseSync,
  from: number,
  to: number,
  limit = 5_000,
): readonly {
  readonly callId: string;
  readonly ts: number;
  readonly tool: string;
  readonly arguments: unknown;
  readonly result: string;
  readonly executionStatus: string;
  readonly signals: ReviewSignals | null;
  readonly effect: unknown;
  readonly fingerprint: string;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT call_id, ts, tool, arguments, result, execution_status, signals, effect, fingerprint,
                record_format_version
           FROM calls WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(from, to, limit),
  );
  return rows.flatMap((row) => {
    // An analysis pass needs semantics this build can interpret; an unknown
    // format is skipped rather than guessed at. The row itself stays stored.
    if (!readableFormat(formatOf(row))) return [];
    return [
      {
        callId: rowText(row['call_id']),
        ts: rowNumber(row['ts']),
        tool: rowText(row['tool']),
        arguments: rowJson(row['arguments']),
        result: rowText(row['result']),
        executionStatus: rowText(row['execution_status']),
        signals: rowSignals(row['signals']),
        effect: rowJson(row['effect']),
        fingerprint: rowText(row['fingerprint']),
      },
    ];
  });
}

export function priorVerdictsForSession(
  db: DatabaseSync,
  sessionId: string,
  limit: number,
): readonly {
  readonly ts: number;
  readonly callId: string;
  readonly configRevision: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly trace: readonly string[];
  readonly result: string;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
  readonly effect: unknown;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT ts, call_id, config_revision, tool, fingerprint, trace, result, reason, decision_rules, effect
           FROM calls WHERE session_id = ? AND result NOT IN ('allow', 'review-allow', 'human-allow')
           ORDER BY ts DESC LIMIT ?`,
      )
      .all(sessionId, limit),
  );
  return rows.map((row) => {
    const trace = rowTrace(row['trace']);
    const rule = trace.find((stage) => stage.stage === 'rule');
    return {
      ts: rowNumber(row['ts']),
      callId: rowText(row['call_id']),
      configRevision: rowText(row['config_revision']),
      tool: rowText(row['tool']),
      fingerprint: rowText(row['fingerprint']),
      trace: trace.map((stage) => stage.result),
      result: rowText(row['result']),
      reason: rowText(row['reason']),
      ruleId: rule?.ruleId ?? null,
      decisionRules: rowStrings(row['decision_rules']),
      effect: rowJson(row['effect']),
    };
  });
}

export function recentForReplay(
  db: DatabaseSync,
  limit = 200,
): readonly {
  readonly callId: string;
  readonly tool: string;
  readonly signals: ReviewSignals;
  readonly result: string;
  readonly strategy: string | null;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT call_id, tool, signals, result, policy_strategy, record_format_version
           FROM calls WHERE signals IS NOT NULL ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit),
  );
  return rows.flatMap((row) => {
    if (!readableFormat(formatOf(row))) return [];
    const signals = rowSignals(row['signals']);
    if (signals === null) return [];
    return [
      {
        callId: rowText(row['call_id']),
        tool: rowText(row['tool']),
        signals,
        result: rowText(row['result']),
        strategy:
          typeof row['policy_strategy'] === 'string'
            ? row['policy_strategy']
            : null,
      },
    ];
  });
}

export function listCandidates(
  db: DatabaseSync,
  status?: string,
): readonly CandidateRecord[] {
  const rows = asRows(
    status === undefined
      ? db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all()
      : db
          .prepare(
            'SELECT * FROM candidates WHERE status = ? ORDER BY created_at DESC',
          )
          .all(status),
  );
  return rows.map((row) => {
    const statusValue = rowText(row['status'], 'pending');
    const candidateStatus: CandidateRecord['status'] =
      statusValue === 'accepted' || statusValue === 'rejected'
        ? statusValue
        : 'pending';
    return {
      candidateId: rowText(row['candidate_id']),
      createdAt: rowNumber(row['created_at']),
      status: candidateStatus,
      rule: rowJson(row['rule']),
      stats: rowJson(row['stats']),
      evidence: rowJson(row['evidence']),
      windowStart: rowNumber(row['window_start']),
      windowEnd: rowNumber(row['window_end']),
      note: typeof row['note'] === 'string' ? row['note'] : null,
    };
  });
}
