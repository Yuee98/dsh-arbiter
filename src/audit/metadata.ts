import type { ArbiterConfig } from '../types.js';
import type { CandidateRecord } from './types.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hash, json } from './rows.js';
export function saveConfigSnapshot(
  db: DatabaseSync,
  config: ArbiterConfig,
): {
  readonly snapshotId: string;
  readonly revision: string;
} {
  const content = JSON.stringify(config);
  const contentHash = hash(content);
  const snapshotId = `cfg-${contentHash.slice(0, 16)}`;
  db.prepare(
    'INSERT OR IGNORE INTO config_snapshots(snapshot_id, content_hash, content, format_version, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(snapshotId, contentHash, content, 1, Date.now());
  return { snapshotId, revision: contentHash.slice(0, 12) };
}

export function recordActivation(
  db: DatabaseSync,
  snapshotId: string,
  revision: string,
  entry: string,
  scope: string,
): void {
  const id = `act-${randomUUID()}`;
  db.prepare(
    'INSERT INTO config_activations(id, snapshot_id, activated_at, entry, scope, revision) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, snapshotId, Date.now(), entry, scope, revision);
}

export function saveCandidate(
  db: DatabaseSync,
  candidate: CandidateRecord,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO candidates(candidate_id, created_at, status, rule, stats, evidence, window_start, window_end, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.candidateId,
    candidate.createdAt,
    candidate.status,
    json(candidate.rule),
    json(candidate.stats),
    json(candidate.evidence),
    candidate.windowStart,
    candidate.windowEnd,
    candidate.note,
  );
}

export function updateCandidateStatus(
  db: DatabaseSync,
  candidateId: string,
  status: CandidateRecord['status'],
  note: string | null,
): void {
  db.prepare(
    'UPDATE candidates SET status = ?, note = ? WHERE candidate_id = ?',
  ).run(status, note, candidateId);
}

export function recordAnalysis(
  db: DatabaseSync,
  windowStart: number,
  windowEnd: number,
  considered: number,
  created: number,
): void {
  db.prepare(
    'INSERT INTO analysis_runs(id, ran_at, window_start, window_end, considered, created) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    `run-${randomUUID()}`,
    Date.now(),
    windowStart,
    windowEnd,
    considered,
    created,
  );
}
