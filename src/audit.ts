/**
 * SQLite audit store, write queue and retention.
 *
 * Audit persistence is a consumer of the decision flow, never a prerequisite.
 * The gate records the permission result first and hands a complete immutable
 * event to this bounded, retrying queue. A storage failure can lose history but
 * cannot change the current permission outcome.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  ArbiterConfig,
  CallResult,
  ModelAttemptRecord,
  ReviewSignals,
  ReviewSnapshot,
  TraceStage,
} from './types.js';

const SCHEMA_VERSION = 1;

export interface CallRecord {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: 'main' | 'subagent';
  readonly parentSession: string | null;
  readonly profile: string | null;
  readonly workspace: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly cwd: string;
  readonly fingerprint: string;
  readonly configRevision: string;
  readonly configSnapshotId: string;
  readonly approvalMode: string;
  readonly executionMode: string;
  readonly result: CallResult;
  readonly reason: string;
  readonly trace: readonly TraceStage[];
  readonly effect: unknown;
  readonly sessionRecordState: string;
  readonly snapshot: ReviewSnapshot | null;
  readonly modelAttempts: readonly ModelAttemptRecord[];
  readonly signals: ReviewSignals | null;
  readonly policyStrategy: string | null;
  readonly decisionRules: readonly string[];
  readonly executionStatus: string;
}

export interface AuditHealth {
  readonly state: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  readonly lastError: string | null;
  readonly dropped: number;
  readonly pending: number;
}

export interface CallFilter {
  readonly limit?: number;
  readonly offset?: number;
  readonly result?: string;
  readonly tool?: string;
  readonly sessionId?: string;
  readonly query?: string;
  readonly from?: number;
  readonly to?: number;
}

export interface CallSummary {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly tool: string;
  readonly command: string;
  readonly result: string;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly approvalMode: string;
  readonly decisionRules: readonly string[];
}

export interface CandidateRecord {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly rule: unknown;
  readonly stats: unknown;
  readonly evidence: unknown;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly note: string | null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rowText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return fallback;
}

function rowNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function rowJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

function rowStrings(value: unknown): string[] {
  const parsed = rowJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function rowTrace(value: unknown): TraceStage[] {
  const parsed = rowJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is TraceStage =>
      isRecord(entry) &&
      typeof entry['stage'] === 'string' &&
      typeof entry['result'] === 'string' &&
      typeof entry['at'] === 'number',
  );
}

function rowDistribution(
  value: unknown,
): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function rowSignals(value: unknown): ReviewSignals | null {
  const parsed = rowJson(value);
  if (!isRecord(parsed)) return null;
  if (parsed['source'] !== 'chat' && parsed['source'] !== 'decision')
    return null;
  const riskClass = parsed['riskClass'];
  const authClass = parsed['authClass'];
  if (riskClass !== 'low' && riskClass !== 'medium' && riskClass !== 'high')
    return null;
  if (
    authClass !== 'none' &&
    authClass !== 'implied' &&
    authClass !== 'explicit'
  )
    return null;
  return {
    riskDist: rowDistribution(parsed['riskDist']),
    riskPoint:
      typeof parsed['riskPoint'] === 'number' ? parsed['riskPoint'] : null,
    riskScore:
      typeof parsed['riskScore'] === 'number' ? parsed['riskScore'] : null,
    riskClass,
    authDist: rowDistribution(parsed['authDist']),
    authPoint:
      typeof parsed['authPoint'] === 'number' ? parsed['authPoint'] : null,
    authClass,
    secrets: parsed['secrets'] === true,
    destructive: parsed['destructive'] === true,
    egress: parsed['egress'] === true,
    bulk: parsed['bulk'] === true,
    source: parsed['source'],
    repairs: typeof parsed['repairs'] === 'number' ? parsed['repairs'] : 0,
  };
}

function rowChanges(value: unknown): number {
  return isRecord(value) ? rowNumber(value['changes']) : 0;
}

function asRow(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

  constructor(path: string, config: ArbiterConfig['audit']) {
    this.path = path;
    this.config = config;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    const versionRow = this.db.prepare('PRAGMA user_version').get();
    const currentVersion =
      versionRow !== undefined && 'user_version' in versionRow
        ? Number(versionRow['user_version'])
        : 0;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `audit database schema ${String(currentVersion)} is newer than this plugin (${String(SCHEMA_VERSION)}); refusing to modify it`,
      );
    }
    if (currentVersion === SCHEMA_VERSION) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL,
          format_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS config_activations (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          activated_at INTEGER NOT NULL,
          entry TEXT NOT NULL,
          scope TEXT NOT NULL,
          revision TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS calls (
          call_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          session_kind TEXT NOT NULL,
          parent_session TEXT,
          profile TEXT,
          workspace TEXT,
          tool TEXT NOT NULL,
          arguments TEXT NOT NULL,
          cwd TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          config_revision TEXT NOT NULL,
          config_snapshot_id TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          execution_mode TEXT NOT NULL,
          result TEXT NOT NULL,
          reason TEXT NOT NULL,
          trace TEXT NOT NULL,
          effect TEXT NOT NULL,
          session_record_state TEXT NOT NULL,
          signals TEXT,
          policy_strategy TEXT,
          decision_rules TEXT NOT NULL,
          execution_status TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts DESC);
        CREATE INDEX IF NOT EXISTS calls_result ON calls(result);
        CREATE INDEX IF NOT EXISTS calls_session ON calls(session_id);
        CREATE TABLE IF NOT EXISTS stages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          stage TEXT NOT NULL,
          result TEXT NOT NULL,
          reason TEXT,
          rule_id TEXT,
          decision_rules TEXT,
          config_revision TEXT,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stages_call ON stages(call_id, seq);
        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
          content_hash TEXT NOT NULL,
          content TEXT NOT NULL,
          format_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_calls (
          id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          backend TEXT NOT NULL,
          protocol TEXT NOT NULL,
          request TEXT NOT NULL,
          response_text TEXT,
          parsed TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          estimated_input_tokens INTEGER NOT NULL,
          usage TEXT
        );
        CREATE INDEX IF NOT EXISTS model_calls_call ON model_calls(call_id, attempt);
        CREATE TABLE IF NOT EXISTS candidates (
          candidate_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          rule TEXT NOT NULL,
          stats TEXT NOT NULL,
          evidence TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          window_end INTEGER NOT NULL,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS analysis_runs (
          id TEXT PRIMARY KEY,
          ran_at INTEGER NOT NULL,
          window_start INTEGER NOT NULL,
          window_end INTEGER NOT NULL,
          considered INTEGER NOT NULL,
          created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        PRAGMA user_version = ${String(SCHEMA_VERSION)};
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Keep the original error.
      }
      throw error;
    }
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
    const content = JSON.stringify(config);
    const contentHash = hash(content);
    const snapshotId = `cfg-${contentHash.slice(0, 16)}`;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO config_snapshots(snapshot_id, content_hash, content, format_version, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(snapshotId, contentHash, content, 1, Date.now());
    return { snapshotId, revision: contentHash.slice(0, 12) };
  }

  configHistory(limit = 20): readonly {
    readonly id: string;
    readonly activatedAt: number;
    readonly revision: string;
    readonly entry: string;
    readonly scope: string;
    readonly snapshotId: string;
  }[] {
    const rows = asRows(
      this.db
        .prepare(
          `SELECT id, activated_at, revision, entry, scope, snapshot_id
           FROM config_activations ORDER BY activated_at DESC LIMIT ?`,
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

  recordActivation(
    snapshotId: string,
    revision: string,
    entry: string,
    scope: string,
  ): void {
    const id = `act-${randomUUID()}`;
    this.db
      .prepare(
        'INSERT INTO config_activations(id, snapshot_id, activated_at, entry, scope, revision) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, snapshotId, Date.now(), entry, scope, revision);
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
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO calls(
            call_id, ts, session_id, session_kind, parent_session, profile, workspace, tool, arguments,
            cwd, fingerprint, config_revision, config_snapshot_id, approval_mode, execution_mode,
            result, reason, trace, effect, session_record_state, signals, policy_strategy,
            decision_rules, execution_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
      this.db
        .prepare('DELETE FROM stages WHERE call_id = ?')
        .run(record.callId);
      const stageStatement = this.db.prepare(
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
      if (record.snapshot !== null) {
        const content = json(record.snapshot);
        this.db
          .prepare(
            'INSERT OR REPLACE INTO snapshots(snapshot_id, call_id, content_hash, content, format_version, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            `${record.callId}:snapshot`,
            record.callId,
            hash(content),
            content,
            1,
            now,
          );
      }
      const modelStatement = this.db.prepare(
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
      this.db.exec('COMMIT');
      this.lastError = null;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure; the original error is reported.
      }
      throw error;
    }
  }

  listCalls(filter: CallFilter = {}): {
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
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM calls ${where}`)
        .get(...values),
    );
    const total = rowNumber(totalRow['count']);
    const rows = asRows(
      this.db
        .prepare(
          `SELECT call_id, ts, session_id, session_kind, tool, arguments, result, reason, approval_mode, decision_rules
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
          approvalMode: rowText(row['approval_mode']),
          decisionRules: rowStrings(row['decision_rules']),
        };
      }),
    };
  }

  getCall(callId: string): unknown {
    const callValue = this.db
      .prepare('SELECT * FROM calls WHERE call_id = ?')
      .get(callId);
    if (callValue === undefined) return null;
    const call = asRow(callValue);
    const stages = asRows(
      this.db
        .prepare('SELECT * FROM stages WHERE call_id = ? ORDER BY seq')
        .all(callId),
    );
    const snapshotValue = this.db
      .prepare('SELECT content FROM snapshots WHERE call_id = ?')
      .get(callId);
    const snapshot = asRow(snapshotValue);
    const models = asRows(
      this.db
        .prepare('SELECT * FROM model_calls WHERE call_id = ? ORDER BY attempt')
        .all(callId),
    );
    const configValue = this.db
      .prepare('SELECT content FROM config_snapshots WHERE snapshot_id = ?')
      .get(rowText(call['config_snapshot_id']));
    const config = asRow(configValue);
    return {
      callId: rowText(call['call_id']),
      ts: rowNumber(call['ts']),
      sessionId: rowText(call['session_id']),
      sessionKind: rowText(call['session_kind'], 'main'),
      parentSession:
        typeof call['parent_session'] === 'string'
          ? call['parent_session']
          : null,
      profile: typeof call['profile'] === 'string' ? call['profile'] : null,
      workspace:
        typeof call['workspace'] === 'string' ? call['workspace'] : null,
      tool: rowText(call['tool']),
      arguments: rowJson(call['arguments']),
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
      stages: stages.map((stage) => ({
        seq: rowNumber(stage['seq']),
        stage: rowText(stage['stage']),
        result: rowText(stage['result']),
        reason: typeof stage['reason'] === 'string' ? stage['reason'] : null,
        ruleId: typeof stage['rule_id'] === 'string' ? stage['rule_id'] : null,
        decisionRules: rowStrings(stage['decision_rules']),
        configRevision:
          typeof stage['config_revision'] === 'string'
            ? stage['config_revision']
            : null,
        ts: rowNumber(stage['ts']),
      })),
      snapshot: rowJson(snapshot['content']),
      modelCalls: models.map((model) => ({
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
      })),
      config: rowJson(config['content']),
    };
  }

  stats(): unknown {
    const rows = asRows(
      this.db
        .prepare(
          'SELECT result, COUNT(*) AS count FROM calls GROUP BY result ORDER BY count DESC',
        )
        .all(),
    );
    const rules = asRows(
      this.db
        .prepare(
          "SELECT result, COUNT(*) AS count FROM stages WHERE stage = 'review' GROUP BY result",
        )
        .all(),
    );
    const callCount = asRow(
      this.db.prepare('SELECT COUNT(*) AS count FROM calls').get(),
    );
    const modelCount = asRow(
      this.db.prepare('SELECT COUNT(*) AS count FROM model_calls').get(),
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
      bytes: this.databaseBytes,
    };
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
    const rows = asRows(
      this.db
        .prepare(
          `SELECT call_id, ts, tool, arguments, result, execution_status, signals, effect, fingerprint
           FROM calls WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(from, to, limit),
    );
    return rows.map((row) => ({
      callId: rowText(row['call_id']),
      ts: rowNumber(row['ts']),
      tool: rowText(row['tool']),
      arguments: rowJson(row['arguments']),
      result: rowText(row['result']),
      executionStatus: rowText(row['execution_status']),
      signals: rowSignals(row['signals']),
      effect: rowJson(row['effect']),
      fingerprint: rowText(row['fingerprint']),
    }));
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
    const rows = asRows(
      this.db
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

  recentForReplay(limit = 200): readonly {
    readonly callId: string;
    readonly tool: string;
    readonly signals: ReviewSignals;
    readonly result: string;
    readonly strategy: string | null;
  }[] {
    const rows = asRows(
      this.db
        .prepare(
          `SELECT call_id, tool, signals, result, policy_strategy FROM calls
           WHERE signals IS NOT NULL ORDER BY ts DESC LIMIT ?`,
        )
        .all(limit),
    );
    return rows.flatMap((row) => {
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

  saveCandidate(candidate: CandidateRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO candidates(candidate_id, created_at, status, rule, stats, evidence, window_start, window_end, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  listCandidates(status?: string): readonly CandidateRecord[] {
    const rows = asRows(
      status === undefined
        ? this.db
            .prepare('SELECT * FROM candidates ORDER BY created_at DESC')
            .all()
        : this.db
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

  updateCandidateStatus(
    candidateId: string,
    status: CandidateRecord['status'],
    note: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE candidates SET status = ?, note = ? WHERE candidate_id = ?',
      )
      .run(status, note, candidateId);
  }

  recordAnalysis(
    windowStart: number,
    windowEnd: number,
    considered: number,
    created: number,
  ): void {
    this.db
      .prepare(
        'INSERT INTO analysis_runs(id, ran_at, window_start, window_end, considered, created) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        `run-${randomUUID()}`,
        Date.now(),
        windowStart,
        windowEnd,
        considered,
        created,
      );
  }

  clearCalls(): number {
    const count = rowNumber(
      asRow(this.db.prepare('SELECT COUNT(*) AS count FROM calls').get())[
        'count'
      ],
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM calls');
      this.db.exec('DELETE FROM candidates');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return count;
  }

  /** Delete expired calls and, when over target, oldest calls until under it. */
  private effectiveBytes(): number {
    const page = asRow(this.db.prepare('PRAGMA page_count').get());
    const free = asRow(this.db.prepare('PRAGMA freelist_count').get());
    const size = asRow(this.db.prepare('PRAGMA page_size').get());
    const used =
      rowNumber(page['page_count']) - rowNumber(free['freelist_count']);
    return Math.max(0, used) * rowNumber(size['page_size']);
  }

  private compact(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Another reader can keep a checkpoint from completing; the next run retries.
    }
    try {
      this.db.exec('VACUUM');
      this.db.exec('PRAGMA optimize');
    } catch {
      // Vacuum is a space optimization, never a permission or retention precondition.
    }
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
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Continue with the current page counts.
    }
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
    let deleted = rowChanges(
      this.db.prepare('DELETE FROM calls WHERE ts < ?').run(cutoff),
    );
    let guard = 0;
    while (this.effectiveBytes() > retentionBytes && guard < 40) {
      guard += 1;
      const remaining = rowNumber(
        asRow(this.db.prepare('SELECT COUNT(*) AS count FROM calls').get())[
          'count'
        ],
      );
      if (remaining <= 1) break;
      const average = asRow(
        this.db
          .prepare(
            `SELECT AVG(
               length(arguments) + length(trace) + length(effect) +
               COALESCE(length(signals), 0) + 256
             ) AS average FROM calls`,
          )
          .get(),
      );
      const excess = this.effectiveBytes() - retentionBytes;
      const batch = Math.max(
        1,
        Math.min(
          32,
          Math.ceil(
            excess / Math.max(rowNumber(average['average'], 1_024), 256),
          ),
        ),
      );
      const changes = rowChanges(
        this.db
          .prepare(
            `DELETE FROM calls WHERE call_id IN (
               SELECT call_id FROM calls ORDER BY ts ASC LIMIT ?
             )`,
          )
          .run(Math.min(batch, remaining - 1)),
      );
      if (changes === 0) break;
      deleted += changes;
    }
    // Shared snapshots without a referencing call are no longer useful.
    this.db
      .prepare(
        'DELETE FROM snapshots WHERE call_id NOT IN (SELECT call_id FROM calls)',
      )
      .run();
    if (deleted > 0 || this.databaseBytes > retentionBytes) this.compact();
    return deleted;
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
