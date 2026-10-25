/** SQLite audit queue and lifecycle. Persistence never gates a permission outcome. */
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArbiterConfig, ReviewSignals } from './types.js';
import type {
  AuditHealth,
  CallRecord,
  CallFilter,
  CallSummary,
  CandidateRecord,
} from './audit/types.js';
export type {
  AuditHealth,
  CallRecord,
  CallFilter,
  CallSummary,
  CandidateRecord,
} from './audit/types.js';
import { hash, json } from './audit/rows.js';
import { migrateAudit } from './audit/schema.js';
import { writeCallRecord } from './audit/writer.js';
import {
  configHistory,
  listCalls,
  getCall,
  stats,
  callsForAnalysis,
  priorVerdictsForSession,
  recentForReplay,
  listCandidates,
} from './audit/queries.js';
import {
  saveConfigSnapshot,
  recordActivation,
  saveCandidate,
  updateCandidateStatus,
  recordAnalysis,
} from './audit/metadata.js';
import { clearCalls, runRetention } from './audit/retention.js';
export function fingerprintOf(tool: string, args: unknown): string {
  return `${tool}:${hash(json(args)).slice(0, 24)}`;
}
export class AuditStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private config: ArbiterConfig['audit'];
  private queue: { readonly record: CallRecord; readonly attempt: number }[] =
    [];
  private scheduled = false;
  private closedState = false;
  private dropped = 0;
  private lastError: string | null = null;
  private degraded = false;

  constructor(path: string, config: ArbiterConfig['audit']) {
    this.path = path;
    this.config = config;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    migrateAudit(this.db);
  }

  get databasePath(): string {
    return this.path;
  }

  get closed(): boolean {
    return this.closedState;
  }

  updateConfig(config: ArbiterConfig['audit']): void {
    this.config = config;
  }

  get databaseBytes(): number {
    let total = 0;
    for (const candidate of [
      this.path,
      `${this.path}-wal`,
      `${this.path}-shm`,
    ]) {
      try {
        total += statSync(candidate).size;
      } catch {
        // A missing sidecar is normal.
      }
    }
    return total;
  }

  health(): AuditHealth {
    if (!this.config.enabled) {
      return {
        state: 'disabled',
        lastError: null,
        dropped: this.dropped,
        pending: this.queue.length,
      };
    }
    if (this.closedState) {
      return {
        state: 'unavailable',
        lastError: this.lastError,
        dropped: this.dropped,
        pending: this.queue.length,
      };
    }
    return {
      state: this.degraded ? 'degraded' : 'ok',
      lastError: this.lastError,
      dropped: this.dropped,
      pending: this.queue.length,
    };
  }

  /** Insert or reuse one immutable configuration snapshot. */
  saveConfigSnapshot(config: ArbiterConfig): {
    readonly snapshotId: string;
    readonly revision: string;
  } {
    return saveConfigSnapshot(this.db, config);
  }

  configHistory(limit = 20): readonly {
    readonly id: string;
    readonly activatedAt: number;
    readonly revision: string;
    readonly entry: string;
    readonly scope: string;
    readonly snapshotId: string;
  }[] {
    return configHistory(this.db, limit);
  }

  recordActivation(
    snapshotId: string,
    revision: string,
    entry: string,
    scope: string,
  ): void {
    recordActivation(this.db, snapshotId, revision, entry, scope);
  }

  enqueue(record: CallRecord): void {
    if (!this.config.enabled || this.closed) return;
    if (this.queue.length >= this.config.maxQueue) {
      this.dropped += 1;
      this.degraded = true;
      this.lastError = 'audit queue is full; oldest queued event was dropped';
      this.queue.shift();
    }
    this.queue.push({ record, attempt: 0 });
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.closedState) return;
    for (;;) {
      if (this.queue.length === 0) break;
      const item = this.queue[0];
      if (item === undefined) break;
      try {
        this.write(item.record);
        this.queue.shift();
        this.degraded =
          this.queue.length >= Math.max(1, this.config.maxQueue - 1) ||
          this.dropped > 0;
        if (this.queue.length === 0 && this.dropped === 0)
          this.degraded = false;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        const attempt = item.attempt + 1;
        this.queue.shift();
        if (attempt < 3) {
          this.queue.push({ record: item.record, attempt });
        } else {
          this.dropped += 1;
        }
        this.degraded = true;
        break;
      }
    }
    if (this.queue.length > 0) {
      setTimeout(() => {
        this.schedule();
      }, 250);
    }
  }

  private write(record: CallRecord): void {
    writeCallRecord(this.db, record);
    this.lastError = null;
  }

  listCalls(filter: CallFilter = {}): {
    readonly rows: CallSummary[];
    readonly total: number;
  } {
    return listCalls(this.db, filter);
  }

  getCall(callId: string): unknown {
    return getCall(this.db, callId);
  }

  stats(): unknown {
    return stats(this.db, () => this.databaseBytes);
  }

  callsForAnalysis(
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
    return callsForAnalysis(this.db, from, to, limit);
  }

  updateExecution(callId: string, status: string): void {
    try {
      this.db
        .prepare('UPDATE calls SET execution_status = ? WHERE call_id = ?')
        .run(status, callId);
      this.db
        .prepare(
          "UPDATE stages SET result = ? WHERE call_id = ? AND stage = 'execution'",
        )
        .run(status, callId);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.degraded = true;
    }
  }

  priorVerdictsForSession(
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
    return priorVerdictsForSession(this.db, sessionId, limit);
  }

  recentForReplay(limit = 200): readonly {
    readonly callId: string;
    readonly tool: string;
    readonly signals: ReviewSignals;
    readonly result: string;
    readonly strategy: string | null;
  }[] {
    return recentForReplay(this.db, limit);
  }

  saveCandidate(candidate: CandidateRecord): void {
    saveCandidate(this.db, candidate);
  }

  listCandidates(status?: string): readonly CandidateRecord[] {
    return listCandidates(this.db, status);
  }

  updateCandidateStatus(
    candidateId: string,
    status: CandidateRecord['status'],
    note: string | null,
  ): void {
    updateCandidateStatus(this.db, candidateId, status, note);
  }

  recordAnalysis(
    windowStart: number,
    windowEnd: number,
    considered: number,
    created: number,
  ): void {
    recordAnalysis(this.db, windowStart, windowEnd, considered, created);
  }

  clearCalls(): number {
    return clearCalls(this.db);
  }

  /**
   * Delete expired calls, then reclaim space without chasing a physical size
   * that DELETE cannot shrink. Capacity decisions use used pages minus free
   * pages; a checkpoint and VACUUM run after logical deletion so the physical
   * file can actually fall. Recent rows are never deleted merely because WAL or
   * free pages still count toward the file size.
   */
  runRetention(
    now = Date.now(),
    retentionDays = this.config.retentionDays,
    retentionBytes = this.config.retentionBytes,
  ): number {
    return runRetention(
      this.db,
      now,
      retentionDays,
      retentionBytes,
      () => this.databaseBytes,
    );
  }

  async flush(): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      if (this.queue.length === 0) return;
      this.drain();
      if (this.queue.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    if (this.closedState) return;
    this.closedState = true;
    try {
      this.db.close();
    } catch {
      // Closing is best effort.
    }
  }
}
export function resolveAuditPath(dshHome: string): string {
  return `${dshHome}/arbiter/arbiter.db`;
}
