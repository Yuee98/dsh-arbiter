/** SQLite audit queue and lifecycle. Persistence never gates a permission outcome. */
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArbiterConfig, ReviewScores } from './types.js';
import type {
  AuditHealth,
  CallFilter,
  CallPage,
  CallRecord,
  CandidateRecord,
  StoredCall,
} from './audit/types.js';
export type {
  AuditHealth,
  CallFilter,
  CallPage,
  CallRecord,
  CandidateRecord,
  StoredCall,
} from './audit/types.js';
import { hash, json, rowChanges } from './audit/rows.js';
import { clampPageSize } from './audit/call-list.js';
import { backupPaths, migrateAudit } from './audit/schema.js';
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
import { storedReads } from './audit/verdict-sources.js';
import type { StoredStage, StoredVerdict } from './audit/verdict-sources.js';
import {
  saveConfigSnapshot,
  recordActivation,
  saveCandidate,
  updateCandidateStatus,
  recordAnalysis,
} from './audit/metadata.js';
import {
  claimRetention,
  clearGeneration,
  markCleared,
  ownsRetention,
  releaseRetention,
  retentionMemberId,
  retentionPolicyOf,
} from './audit/ownership.js';
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
export function fingerprintOf(tool: string, args: unknown): string {
  return `${tool}:${hash(json(args)).slice(0, 24)}`;
}
export class AuditStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private config: ArbiterConfig['audit'];
  private queue: {
    readonly record: CallRecord;
    readonly attempt: number;
    /**
     * The path's clear generation when this event was queued. An event from an
     * older generation predates a clear of the shared database and is dropped.
     */
    readonly generation: number;
  }[] = [];
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
  /** Identity used for the per-path retention registry. */
  private readonly member = { id: retentionMemberId() };
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
    const claim = claimRetention(path, this.member, this.config);
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

  /**
   * The retention policy this database actually uses.
   *
   * Read live from the path, so a follower observes the owner's current values
   * rather than the copy it saw when it opened.
   */
  get retention(): { readonly days: number; readonly bytes: number } {
    const live = retentionPolicyOf(this.path);
    return {
      days: live?.days ?? this.config.retentionDays,
      bytes: live?.bytes ?? this.config.retentionBytes,
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
    const claim = claimRetention(this.path, this.member, config);
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
    // Adopt the policy the registry actually holds. On a routine refresh that
    // is the inherited instance policy, not the profile-local value the caller
    // passed in, so a promoted owner cannot silently replace it.
    this.config = {
      ...config,
      retentionDays: claim.days,
      retentionBytes: claim.bytes,
    };
    this.degraded = false;
    this.lastError = null;
  }

  /**
   * Bytes of auxiliary audit files that deleting rows cannot reclaim.
   *
   * Migration backups and the WAL/SHM sidecars are separate files; the database
   * itself is deliberately excluded, because its free pages are reclaimable by
   * compaction and therefore belong to the database's own budget.
   */
  private get auxiliaryBytes(): number {
    let total = 0;
    for (const candidate of [
      `${this.path}-wal`,
      `${this.path}-shm`,
      ...backupPaths(this.path),
    ]) {
      try {
        total += statSync(candidate).size;
      } catch {
        // A missing sidecar or backup is normal.
      }
    }
    return total;
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
      ...backupPaths(this.path),
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
    this.queue.push({
      record,
      attempt: 0,
      generation: clearGeneration(this.path),
    });
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
      if (item.generation !== clearGeneration(this.path)) {
        // This event predates a clear of the shared database: the user asked to
        // remove that history, so it is dropped rather than written back.
        this.queue.shift();
        continue;
      }
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
          this.queue.push({
            record: item.record,
            attempt,
            generation: item.generation,
          });
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

  /**
   * Run one read, reporting an unreadable structure as an empty result.
   *
   * A database this build cannot interpret must not throw through an HTTP
   * route; the caller returns a payload with `audit-unavailable` and the health
   * reason instead.
   */
  private readGuard<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.degraded = true;
      return fallback;
    }
  }

  /**
   * One page of the call list, plus the cursors that continue it.
   *
   * A degraded read answers with no rows and no cursor, so a caller cannot
   * mistake "storage failed" for "this traversal ended".
   */
  listCalls(
    filter: CallFilter = {},
  ): CallPage & { readonly unreadable?: boolean } {
    return this.readGuard<CallPage & { readonly unreadable?: boolean }>(
      () => listCalls(this.db, filter),
      {
        rows: [],
        total: 0,
        limit: clampPageSize(filter.limit),
        nextCursor: null,
        prevCursor: null,
        anchor: filter.anchor ?? null,
        newer: 0,
        remaining: 0,
        unreadable: true,
      },
    );
  }

  /**
   * Read one call.
   *
   * `unreadable` distinguishes a structure this build cannot read from a call
   * that genuinely does not exist; a route must not report the first as 404.
   */
  /** One stored call, or null when it does not exist or cannot be read. */
  getCall(callId: string): StoredCall | null {
    return this.readGuard(() => getCall(this.db, callId), null);
  }

  /**
   * Read one call, telling "cannot read this structure" from "no such call".
   *
   * A route must not report an incompatible database as a missing record.
   */
  readCall(callId: string): {
    readonly record: StoredCall | null;
    readonly unreadable: boolean;
  } {
    try {
      return { record: getCall(this.db, callId), unreadable: false };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.degraded = true;
      return { record: null, unreadable: true };
    }
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
    readonly scores: ReviewScores | null;
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

  /**
   * Apply one execution observation to an existing row; returns rows changed.
   *
   * Only the terminal observation is recorded. `execution_started_at` stays
   * NULL unless a genuine start signal was stored earlier: `tools/result` tells
   * us the call finished, and copying that timestamp into "started at" would
   * claim an observation nobody made.
   */
  private markExecuted(callId: string, status: string, at: number): number {
    const changed = rowChanges(
      this.db
        .prepare(
          `UPDATE calls
              SET execution_status = ?,
                  execution_finished_at = ?
            WHERE call_id = ?`,
        )
        .run(status, at, callId),
    );
    this.db
      .prepare(
        "UPDATE stages SET result = ? WHERE call_id = ? AND stage = 'execution'",
      )
      .run(status, callId);
    return changed;
  }

  /**
   * Record that execution actually began.
   *
   * This is the only writer of `execution_started_at`. A call whose start was
   * never observed keeps NULL even after it finishes, so the record never
   * invents a start time from a finish observation.
   */
  markExecutionStarted(callId: string, at = Date.now()): void {
    if (this.pausedReason !== null) return;
    try {
      this.db
        .prepare(
          'UPDATE calls SET execution_started_at = ? WHERE call_id = ? AND execution_started_at IS NULL',
        )
        .run(at, callId);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.degraded = true;
    }
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

  /**
   * Prior verdicts for one session, with the count of rows excluded by format.
   *
   * A caller must be able to distinguish "no history" from "history exists but
   * this build cannot read it"; both are an empty list otherwise.
   */
  /**
   * The stored result of specific calls, including ones the window filter drops.
   *
   * Used to detect a cross-source contradiction on an already selected call: an
   * audit `allow` against a session `deny` is invisible to the window query.
   */
  verdictsForCalls(
    sessionId: string,
    callIds: readonly string[],
  ): readonly StoredVerdict[] {
    try {
      return storedReads(this.db).calls(sessionId, callIds);
    } catch (error) {
      this.markDegraded(error);
      return [];
    }
  }

  /**
   * The full stored stage chain for one call, or `[]` when it has none.
   *
   * Recovery uses this to complete a chain another source recorded only partly; it
   * reads stages rather than re-projecting the call row, so no new schema or
   * migration is involved.
   */
  priorVerdictStages(callId: string): readonly StoredStage[] {
    try {
      return storedReads(this.db).stages(callId);
    } catch (error) {
      this.markDegraded(error);
      return [];
    }
  }

  /** Record a degraded completion read without failing the whole store. */
  private markDegraded(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.degraded = true;
  }

  priorVerdictsForSession(
    sessionId: string,
    limit: number,
  ): {
    readonly verdicts: readonly {
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
    }[];
    readonly unreadableCount: number;
  } {
    return this.readGuard(
      () => priorVerdictsForSession(this.db, sessionId, limit),
      { verdicts: [], unreadableCount: 0 },
    );
  }

  recentForReplay(limit = 200): readonly {
    readonly callId: string;
    readonly tool: string;
    readonly scores: ReviewScores;
    readonly result: string;
    readonly reviewStage: string | null;
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
  clearCalls(): { readonly ok: boolean; readonly deleted: number } {
    if (this.pausedReason !== null) return { ok: false, deleted: 0 };
    // The queue is invalidated only together with a successful clear: dropping
    // queued events before the SQL result is known would lose them when the
    // delete fails, and keeping them after a successful clear would let them
    // reappear.
    const cleared = this.guard(() => clearCalls(this.db));
    if (cleared === null) return { ok: false, deleted: 0 };
    this.queue.splice(0);
    this.earlyResults.clear();
    // A second store on the same database may hold events queued before this
    // clear; they would be inserted afterwards and resurrect the cleared
    // history. The cutoff makes them discardable by any store on this path.
    markCleared(this.path);
    return { ok: true, deleted: cleared };
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
  /**
   * Run one cleanup pass.
   *
   * Only the path's current owner executes cleanup, so a follower profile
   * cannot delete rows under stale thresholds. The policy is read live from the
   * path, so an owner's later change applies to every store sharing the file.
   */
  runRetention(
    now = Date.now(),
    retentionDays?: number,
    retentionBytes?: number,
  ): AuditRetentionOutcome {
    if (!ownsRetention(this.path, this.member)) {
      // A follower reports the live footprint but never deletes.
      return { deleted: 0, irreducible: false, bytes: this.databaseBytes };
    }
    const policy = retentionPolicyOf(this.path);
    const days = retentionDays ?? policy?.days ?? this.config.retentionDays;
    const bytes = retentionBytes ?? policy?.bytes ?? this.config.retentionBytes;
    // Scheduled from an interval, so a throw here would escape into the host.
    return (
      this.guard(() =>
        runRetention(this.db, now, days, bytes, () => this.auxiliaryBytes),
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
    releaseRetention(this.path, this.member);
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
