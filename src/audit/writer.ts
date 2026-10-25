import type { DatabaseSync } from 'node:sqlite';
import type { CallRecord } from './types.js';
import { json, hash } from './rows.js';
function insertCall(db: DatabaseSync, record: CallRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO calls(
            call_id, ts, session_id, session_kind, parent_session, profile, workspace, tool, arguments,
            cwd, fingerprint, config_revision, config_snapshot_id, approval_mode, execution_mode,
            result, reason, trace, effect, session_record_state, signals, policy_strategy,
            decision_rules, execution_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.callId,
    record.ts,
    record.sessionId,
    record.sessionKind,
    record.parentSession,
    record.profile,
    record.workspace,
    record.tool,
    json(record.arguments),
    record.cwd,
    record.fingerprint,
    record.configRevision,
    record.configSnapshotId,
    record.approvalMode,
    record.executionMode,
    record.result,
    record.reason,
    json(record.trace),
    json(record.effect),
    record.sessionRecordState,
    record.signals === null ? null : json(record.signals),
    record.policyStrategy,
    json(record.decisionRules),
    record.executionStatus,
  );
}
function insertStages(db: DatabaseSync, record: CallRecord): void {
  db.prepare('DELETE FROM stages WHERE call_id = ?').run(record.callId);
  const stageStatement = db.prepare(
    'INSERT INTO stages(call_id, seq, stage, result, reason, rule_id, decision_rules, config_revision, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  record.trace.forEach((stage, index) => {
    stageStatement.run(
      record.callId,
      index,
      stage.stage,
      stage.result,
      stage.reason ?? null,
      stage.ruleId ?? null,
      stage.decisionRules === undefined ? null : json(stage.decisionRules),
      stage.configRevision ?? null,
      stage.at,
    );
  });
}
function insertSnapshot(
  db: DatabaseSync,
  record: CallRecord,
  now: number,
): void {
  if (record.snapshot !== null) {
    const content = json(record.snapshot);
    db.prepare(
      'INSERT OR REPLACE INTO snapshots(snapshot_id, call_id, content_hash, content, format_version, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      `${record.callId}:snapshot`,
      record.callId,
      hash(content),
      content,
      1,
      now,
    );
  }
}
function insertModelAttempts(db: DatabaseSync, record: CallRecord): void {
  const modelStatement = db.prepare(
    `INSERT OR REPLACE INTO model_calls(
          id, call_id, attempt, backend, protocol, request, response_text, parsed, error,
          started_at, duration_ms, estimated_input_tokens, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const attempt of record.modelAttempts) {
    modelStatement.run(
      attempt.requestId,
      attempt.callId,
      attempt.attempt,
      attempt.backend,
      attempt.protocol,
      json(attempt.request),
      attempt.responseText,
      attempt.parsed === null ? null : json(attempt.parsed),
      attempt.error,
      attempt.startedAt,
      attempt.durationMs,
      attempt.estimatedInputTokens,
      json(attempt.usage),
    );
  }
}
export function writeCallRecord(db: DatabaseSync, record: CallRecord): void {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    insertCall(db, record);
    insertStages(db, record);
    insertSnapshot(db, record, now);
    insertModelAttempts(db, record);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Preserve the original storage failure. */
    }
    throw error;
  }
}
