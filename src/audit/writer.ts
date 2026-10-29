import type { DatabaseSync } from 'node:sqlite';
import type { CallRecord } from './types.js';
import { json, hash } from './rows.js';
import { RECORD_FORMAT } from './schema.js';
import { saveTemplateSnapshot } from './metadata.js';
function insertCall(db: DatabaseSync, record: CallRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO calls(
            call_id, ts, session_id, session_kind, parent_session, profile, workspace, tool, arguments,
            arguments_schema, cwd, fingerprint, config_revision, config_snapshot_id, approval_mode,
            execution_mode, result, reason, trace, effect, session_record_state, scores,
            review_stage, usage, decision_rules, execution_status, record_format_version,
            execution_started_at, execution_finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    record.argumentsSchema === undefined ? null : json(record.argumentsSchema),
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
    // A current record writes the new shape only. A row with no score writes
    // `NULL`, which the reader reports as "no new-style score" rather than
    // defaulting to a band nobody computed.
    record.scores === null ? null : json(record.scores),
    record.reviewStage,
    record.usage === null ? null : json(record.usage),
    json(record.decisionRules),
    record.executionStatus,
    RECORD_FORMAT,
    record.executionStartedAt ?? null,
    record.executionFinishedAt ?? null,
  );
}
function insertStages(db: DatabaseSync, record: CallRecord): void {
  db.prepare('DELETE FROM stages WHERE call_id = ?').run(record.callId);
  const stageStatement = db.prepare(
    'INSERT INTO stages(call_id, seq, stage, result, reason, rule_id, rule_name, decision_rules, config_revision, config_snapshot_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  record.trace.forEach((stage, index) => {
    stageStatement.run(
      record.callId,
      index,
      stage.stage,
      stage.result,
      stage.reason ?? null,
      stage.ruleId ?? null,
      stage.ruleName ?? null,
      stage.decisionRules === undefined ? null : json(stage.decisionRules),
      stage.configRevision ?? null,
      stage.configSnapshotId ?? null,
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
/**
 * Materialise the templates the attempts reference.
 *
 * The attempt carries the template's content identity; the content itself is
 * stored once per identity and reused across calls. Persisting here keeps the
 * reference from dangling if the adapter's template ever changes between the
 * decision and the write.
 */
function insertTemplates(db: DatabaseSync, record: CallRecord): void {
  for (const attempt of record.modelAttempts) {
    if (attempt.templateId === undefined) continue;
    const system =
      typeof attempt.request === 'object' &&
      attempt.request !== null &&
      'system' in attempt.request &&
      typeof attempt.request.system === 'string'
        ? attempt.request.system
        : '';
    if (system.length === 0) continue;
    const stored = saveTemplateSnapshot(db, system, attempt.protocol);
    // The adapter's id and the stored id are derived from the same content; a
    // mismatch would mean the reference and the row disagree.
    if (stored.templateId !== attempt.templateId) continue;
  }
}

function insertModelAttempts(db: DatabaseSync, record: CallRecord): void {
  const modelStatement = db.prepare(
    `INSERT OR REPLACE INTO model_calls(
          id, call_id, attempt, backend, protocol, request, template_id,
          response_text, parsed, error, started_at, duration_ms,
          estimated_input_tokens, usage, normalized_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const attempt of record.modelAttempts) {
    modelStatement.run(
      attempt.requestId,
      attempt.callId,
      attempt.attempt,
      attempt.backend,
      attempt.protocol,
      json(attempt.request),
      attempt.templateId ?? null,
      attempt.responseText,
      attempt.parsed === null ? null : json(attempt.parsed),
      attempt.error,
      attempt.startedAt,
      attempt.durationMs,
      attempt.estimatedInputTokens,
      // Both values are stored: the masked provider payload exactly as received,
      // so it can be re-normalized after the mapping version changes, and the
      // normalization done under the mapping this build uses.
      json(attempt.usage),
      json(attempt.normalizedUsage),
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
    insertTemplates(db, record);
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
