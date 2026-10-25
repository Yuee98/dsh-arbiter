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
import { hash, json, rowChanges } from './audit/rows.js';
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

/**
 * The outcome of one retention pass.
 *
 * Declared here rather than re-exported from the retention module, because that
 * module imports the SQLite driver type: a consumer of the plugin's public types
 * must not need Node's database typings.
 */
export interface AuditRetentionOutcome {
  readonly deleted: number;
  /** True when the newest record alone already exceeds the byte target. */
  readonly irreducible: boolean;
  readonly bytes: number;
}
/**
 * One effective retention policy and executor per resolved database path.
 *
 * Audit storage is per DSH data instance, not per profile, so two profiles that
 * point at the same file must not delete each other's rows under different
 * thresholds. The first store for a path publishes the policy; later stores
 * adopt it and report a conflict instead of overwriting it. A changed setting
 * from the owning profile is applied through {@link AuditStore.updateConfig},
 * which is the controlled update path.
 */
interface RetentionOwnership {
  retentionDays: number;
  retentionBytes: number;
  readonly owner: AuditStore;
}
const RETENTION_OWNERS = new Map<string, RetentionOwnership>();

function claimRetention(
  path: string,
  store: AuditStore,
  config: ArbiterConfig['audit'],
): {
  readonly days: number;
  readonly bytes: number;
  readonly conflict: boolean;
} {
  const existing = RETENTION_OWNERS.get(path);
  if (existing !== undefined && existing.owner !== store) {
    return {
      days: existing.retentionDays,
      bytes: existing.retentionBytes,
      conflict:
        existing.retentionDays !== config.retentionDays ||
        existing.retentionBytes !== config.retentionBytes,
    };
  }
  if (existing === undefined || existing.owner === store) {
    RETENTION_OWNERS.set(path, {
      retentionDays: config.retentionDays,
      retentionBytes: config.retentionBytes,
      owner: store,
    });
    return {
      days: config.retentionDays,
      bytes: config.retentionBytes,
      conflict: false,
    };
  }
  return {
    days: existing.retentionDays,
    bytes: existing.retentionBytes,
    conflict:
      existing.retentionDays !== config.retentionDays ||
      existing.retentionBytes !== config.retentionBytes,
  };
}

function releaseRetention(path: string, store: AuditStore): void {
  const existing = RETENTION_OWNERS.get(path);
  if (existing?.owner === store) RETENTION_OWNERS.delete(path);
}

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
  /**
   * Why this store stopped writing, if it did.
   *
   * A migration that could not complete leaves the database untouched; the
   * store keeps serving reads and refuses new writes, so approvals never depend
   * on storage. The value is surfaced through `health()`.
   */
  private pausedReason: string | null = null;
  /** True once released; a replaced store must not reschedule maintenance. */
  private released = false;

  constructor(path: string, config: ArbiterConfig['audit']) {
    this.path = path;
    this.config = config;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // A database this build must not modify is checked *before* any mutating
    // pragma: `journal_mode = WAL` rewrites the file header, so running it
    // first would already have altered a newer database we promised not to touch.
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      migrateAudit(this.db, path);
      // Only a database this build owns is switched to WAL.
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      // The database was left as it was. Keep the handle for reads, stop
      // writes, and carry the reason so the UI can explain the pause.
      this.pausedReason =
        error instanceof Error ? error.message : String(error);
      this.lastError = this.pausedReason;
      this.degraded = true;
    }
    // One effective retention policy per database path: a second store for the
    // same file adopts the owner's values instead of changing cleanup semantics
    // for rows the other profile also sees.
    const claim = claimRetention(path, this, this.config);
    this.config = {
      ...this.config,
      retentionDays: claim.days,
      retentionBytes: claim.bytes,
    };
    if (claim.conflict) {
      this.degraded = true;
      this.lastError =
        'another profile set a different audit retention for this database; the existing policy stays in effect';
    }
  }

  /** The retention policy this database actually uses. */
  get retention(): { readonly days: number; readonly bytes: number } {
    return {
      days: this.config.retentionDays,
      bytes: this.config.retentionBytes,
    };
  }

  /** True when this store must not accept new records. */
  get paused(): boolean {
    return this.pausedReason !== null;
  }

  get databasePath(): string {
    return this.path;
  }

  get closed(): boolean {
    return this.closedState;
  }

  /**
   * Adopt a new audit configuration.
   *
   * The retention policy belongs to the database, not to whichever profile
   * applied last: two profiles sharing one data instance must not delete each
   * other's rows under different thresholds. The first policy this store saw
   * stays in force; a later conflicting one is reported and ignored.
   */
  updateConfig(config: ArbiterConfig['audit']): void {
    const claim = claimRetention(this.path, this, config);
    if (claim.conflict) {
      // Another profile owns this database's policy. Report it and keep the
      // effective values, so two profiles cannot fight over deletions.
      this.degraded = true;
      this.lastError =
        'another profile set a different audit retention for this database; the existing policy stays in effect';
      this.config = {
        ...this.config,
        enabled: config.enabled,
        maxQueue: config.maxQueue,
      };
      return;
    }
    // The owning profile changed the instance-level setting: adopt all of it.
    this.config = { ...config };
    this.degraded = false;
    this.lastError = null;
  }

  /**
   * Bytes the retention target governs.
   *
   * The database, its WAL/SHM sidecars and its own migration backups all live
   * in the audit directory, so the capacity goal has to account for them; a
   * database-only measurement would silently exceed the user's budget.
   */
  get databaseBytes(): number {
    let total = 0;
    for (const candidate of [
      this.path,
      `${this.path}-wal`,
      `${this.path}-shm`,
      `${this.path}.backup-v1`,
      `${this.path}.backup-v2`,
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
    if (this.pausedReason !== null) {
      return {
        state: 'unavailable',
        lastError: this.pausedReason,
        dropped: this.dropped,
        pending: this.queue.length,
      };
    }
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

  /**
   * Run one write while a failure is contained.
   *
   * Every mutating path — snapshot, activation, execution update, candidate,
   * analysis, clear and retention — goes through this, so a broken database
   * cannot throw out of an HTTP route or a scheduled callback. Callers use the
   * return value to decide what they can claim, and the health view explains
   * the failure.
   */
  private guard<T>(operation: () => T): T | null {
    if (this.pausedReason !== null || this.closedState) return null;
    try {
      const value = operation();
      this.lastError = null;
      return value;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.degraded = true;
      return null;
    }
  }

  /** Insert or reuse one immutable configuration snapshot. */
  saveConfigSnapshot(config: ArbiterConfig): {
    readonly snapshotId: string;
    readonly revision: string;
  } | null {
    return this.guard(() => saveConfigSnapshot(this.db, config));
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
  ): boolean {
    return (
      this.guard(() => {
        recordActivation(this.db, snapshotId, revision, entry, scope);
        return true;
      }) === true
    );
  }

  /** The largest single record this store will queue; larger ones are dropped. */
  private static readonly MAX_RECORD_BYTES = 8 * 1024 * 1024;

  enqueue(record: CallRecord): void {
    // A paused store accepts nothing: the database's structure is not the one
    // this build writes, and the caller must keep working without it.
    if (this.pausedReason !== null) {
      this.dropped += 1;
      return;
    }
    if (!this.config.enabled || this.closed) return;
    // One oversized record must not be retried forever or pin unbounded memory.
    // It is counted as dropped instead of being held in the queue.
    let size: number;
    try {
      size = JSON.stringify(record).length;
    } catch {
      this.dropped += 1;
      this.degraded = true;
      this.lastError =
        'audit record could not be serialized; event was dropped';
      return;
    }
    if (size > AuditStore.MAX_RECORD_BYTES) {
      this.dropped += 1;
      this.degraded = true;
      this.lastError = `audit record exceeded ${String(AuditStore.MAX_RECORD_BYTES)} bytes; event was dropped`;
      return;
    }
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
    // A result observed before this insert is applied now, so both orderings
    // converge on the same final status.
    this.applyEarlyResult(record.callId);
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

  /**
   * Execution outcomes observed before their record reached the database.
   *
   * `tools/result` can arrive while the record is still in the in-memory queue;
   * an UPDATE would then match no row and the stored status would stay
   * `pending` forever. The observation is held here and applied by the writer
   * once the row exists. The map is bounded so a stream of results without
   * records cannot grow without limit.
   */
  private readonly earlyResults = new Map<
    string,
    { readonly status: string; readonly at: number }
  >();

  /** Bound on execution observations awaiting their record's insertion. */
  private static readonly MAX_EARLY_RESULTS = 512;

  /**
   * Record the observed execution outcome.
   *
   * `execution_status` is the observed result of running the tool, never a copy
   * of the permission verdict: an allowed call that never ran stays `pending`.
   */
  updateExecution(callId: string, status: string, at = Date.now()): void {
    if (this.pausedReason !== null) return;
    try {
      const changed = this.markExecuted(callId, status, at);
      if (changed === 0 && !this.earlyResults.has(callId)) {
        // The record has not been inserted yet (or was dropped). Remember the
        // observation so it is applied when the row appears.
        if (this.earlyResults.size >= AuditStore.MAX_EARLY_RESULTS) {
          const oldest = this.earlyResults.keys().next().value;
          if (oldest !== undefined) this.earlyResults.delete(oldest);
          this.dropped += 1;
        }
        this.earlyResults.set(callId, { status, at });
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.degraded = true;
    }
  }

  /** Apply one execution observation to an existing row; returns rows changed. */
  private markExecuted(callId: string, status: string, at: number): number {
    const changed = rowChanges(
      this.db
        .prepare(
          `UPDATE calls
              SET execution_status = ?,
                  execution_finished_at = ?,
                  execution_started_at = COALESCE(execution_started_at, ?)
            WHERE call_id = ?`,
        )
        .run(status, at, at, callId),
    );
    this.db
      .prepare(
        "UPDATE stages SET result = ? WHERE call_id = ? AND stage = 'execution'",
      )
      .run(status, callId);
    return changed;
  }

  /** Apply an observation that arrived before its record was stored. */
  private applyEarlyResult(callId: string): void {
    const early = this.earlyResults.get(callId);
    if (early === undefined) return;
    this.earlyResults.delete(callId);
    try {
      this.markExecuted(callId, early.status, early.at);
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
    this.guard(() => {
      saveCandidate(this.db, candidate);
    });
  }

  listCandidates(status?: string): readonly CandidateRecord[] {
    return listCandidates(this.db, status);
  }

  updateCandidateStatus(
    candidateId: string,
    status: CandidateRecord['status'],
    note: string | null,
  ): void {
    this.guard(() => {
      updateCandidateStatus(this.db, candidateId, status, note);
    });
  }

  recordAnalysis(
    windowStart: number,
    windowEnd: number,
    considered: number,
    created: number,
  ): void {
    this.guard(() => {
      recordAnalysis(this.db, windowStart, windowEnd, considered, created);
    });
  }

  /**
   * Delete stored calls.
   *
   * The asynchronous queue is drained first: a record enqueued before the clear
   * would otherwise be inserted afterwards, making the cleared history appear
   * to come back. Records enqueued after this point are new events and are kept.
   * Configuration history, activations and session records are out of scope.
   */
  clearCalls(): number {
    if (this.pausedReason !== null) return 0;
    this.queue.splice(0);
    this.drainNow();
    this.earlyResults.clear();
    return clearCalls(this.db);
  }

  /** Drain synchronously, so a caller can rely on the queue being empty after. */
  private drainNow(): void {
    if (this.closedState || this.pausedReason !== null) return;
    this.drain();
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
  ): AuditRetentionOutcome {
    // Scheduled from an interval, so a throw here would escape into the host.
    return (
      this.guard(() =>
        runRetention(
          this.db,
          now,
          retentionDays,
          retentionBytes,
          () => this.databaseBytes,
        ),
      ) ?? { deleted: 0, irreducible: false, bytes: this.databaseBytes }
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
    this.released = true;
    releaseRetention(this.path, this);
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
