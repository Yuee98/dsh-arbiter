import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ToolResultObservation,
  ToolResultRecovery,
  ToolResultSave,
} from './tool-result-types.js';
import { asRow, rowNumber, rowText } from './rows.js';
import { prepareToolResult } from './tool-result-material.js';
import {
  publishToolResult,
  reclaimToolResultFiles,
} from './tool-result-files.js';
import { INLINE_RESULT_BYTES } from './tool-result-slicing.js';
import { resultReceipt } from './tool-result-reader.js';

export function toolResultGeneration(db: DatabaseSync): string {
  return rowText(
    asRow(
      db
        .prepare("SELECT value FROM meta WHERE key = 'tool-result-generation'")
        .get(),
    )['value'],
    '0',
  );
}
function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    /* The failing statement may already have rolled back. */
  }
}
function unavailable(
  state: ToolResultSave['state'],
  reason: string,
): ToolResultSave {
  return { state, receipt: null, equivalence: null, reason };
}
export function unavailableToolResultSave(): ToolResultSave {
  return unavailable('unavailable', 'audit-unavailable');
}
function validObservation(observation: ToolResultObservation): boolean {
  return (
    observation.sessionId.length > 0 &&
    observation.callId.length > 0 &&
    observation.sessionId.length <= 4096 &&
    observation.callId.length <= 4096 &&
    Number.isFinite(observation.observedAt) &&
    (observation.callStartedAt === undefined ||
      Number.isFinite(observation.callStartedAt))
  );
}
function expireAt(
  db: DatabaseSync,
  observation: ToolResultObservation,
): number {
  const row = asRow(
    db
      .prepare('SELECT ts FROM calls WHERE session_id = ? AND call_id = ?')
      .get(observation.sessionId, observation.callId),
  );
  return Math.min(
    observation.observedAt,
    observation.callStartedAt ?? observation.observedAt,
    rowNumber(row['ts'], observation.observedAt),
  );
}
function failedObservation(
  db: DatabaseSync,
  observation: ToolResultObservation,
  generation: string | null,
  anchor: number,
): ToolResultSave {
  if (generation === null)
    return unavailable('failed', 'result-persistence-failed');
  try {
    db.exec('BEGIN IMMEDIATE');
    if (toolResultGeneration(db) !== generation) {
      db.exec('ROLLBACK');
      return unavailable('stale', 'observation-cleared');
    }
    db.prepare(
      `INSERT INTO tool_results(session_id, call_id, result_id, ts, storage, failure)
      VALUES (?, ?, ?, ?, 'failed', 'result-persistence-failed')
      ON CONFLICT(session_id, call_id) DO UPDATE SET failure = excluded.failure
      WHERE tool_results.storage = 'failed'`,
    ).run(observation.sessionId, observation.callId, randomUUID(), anchor);
    const receipt = resultReceipt(
      db,
      observation.sessionId,
      observation.callId,
    );
    db.exec('COMMIT');
    return { ...unavailable('failed', 'result-persistence-failed'), receipt };
  } catch {
    rollback(db);
    return unavailable('failed', 'result-persistence-failed');
  }
}
/** Finalized observations are immutable; repeated keys never assert payload equivalence. */
export function saveToolResult(
  db: DatabaseSync,
  path: string,
  observation: ToolResultObservation,
  days: number,
  now: number,
): ToolResultSave {
  if (!validObservation(observation))
    return unavailable('failed', 'invalid-result-identity');
  let generation: string | null = null;
  let anchor = observation.observedAt;
  try {
    db.exec('BEGIN IMMEDIATE');
    generation = toolResultGeneration(db);
    if (
      observation.generation !== undefined &&
      observation.generation !== toolResultGeneration(db)
    ) {
      db.exec('ROLLBACK');
      return unavailable('stale', 'observation-cleared');
    }
    const existing = asRow(
      db
        .prepare(
          'SELECT storage, result_id FROM tool_results WHERE session_id = ? AND call_id = ?',
        )
        .get(observation.sessionId, observation.callId),
    );
    if (
      typeof existing['storage'] === 'string' &&
      existing['storage'] !== 'failed'
    ) {
      db.exec('ROLLBACK');
      return {
        state: 'already-recorded',
        receipt: {
          sessionId: observation.sessionId,
          callId: observation.callId,
          resultId: rowText(existing['result_id']),
        },
        equivalence: 'unverified',
        reason: 'attempted-payload-not-written',
      };
    }
    const ts = expireAt(db, observation);
    anchor = ts;
    if (ts < now - days * 86_400_000) {
      db.exec('ROLLBACK');
      return unavailable('expired', 'observation-expired');
    }
    const { metadata, body } = prepareToolResult(db, observation);
    const resultId = randomUUID();
    db.prepare(
      'DELETE FROM tool_results WHERE session_id = ? AND call_id = ? AND storage = ?',
    ).run(observation.sessionId, observation.callId, 'failed');
    db.prepare(
      `INSERT INTO tool_results(session_id, call_id, result_id, ts, storage, metadata)
      VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(
      observation.sessionId,
      observation.callId,
      resultId,
      ts,
      JSON.stringify(metadata),
    );
    const external = body.length > INLINE_RESULT_BYTES;
    const fileRef = external ? publishToolResult(path, resultId, body) : null;
    db.prepare(
      'UPDATE tool_results SET storage = ?, body = ?, file_ref = ? WHERE result_id = ?',
    ).run(
      external ? 'file' : body.length === 0 ? 'none' : 'inline',
      external ? null : body.toString('utf8'),
      fileRef,
      resultId,
    );
    db.exec('COMMIT');
    return {
      state: 'saved',
      receipt: {
        sessionId: observation.sessionId,
        callId: observation.callId,
        resultId,
      },
      equivalence: null,
      reason: null,
    };
  } catch {
    rollback(db);
    return failedObservation(db, observation, generation, anchor);
  }
}
export function recoverToolResults(
  db: DatabaseSync,
  path: string,
): ToolResultRecovery {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = reclaimToolResultFiles(db, path);
    db.exec('COMMIT');
    return result;
  } catch {
    rollback(db);
    throw new Error('result-recovery-failed');
  }
}
