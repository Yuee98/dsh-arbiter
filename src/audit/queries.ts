import type { ReviewScores, ReviewStageRecord } from '../types.js';
import type {
  CallFilter,
  CallPage,
  CandidateRecord,
  StoredCall,
} from './types.js';
import { callPage } from './call-list.js';
import {
  LATEST_CALL_FORMAT,
  READABLE_CALL_FORMATS,
  READABLE_CONFIG_SNAPSHOT_FORMATS,
  READABLE_REVIEW_SNAPSHOT_FORMATS,
  READABLE_TEMPLATE_FORMATS,
} from './schema.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  asRow,
  asRows,
  rowText,
  rowNumber,
  rowJson,
  rowStrings,
  rowTrace,
  rowScores,
  rowReviewStage,
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
  return READABLE_CALL_FORMATS.includes(version);
}

/** Whether a stored configuration snapshot's format can be interpreted. */
function readableConfigSnapshot(version: number): boolean {
  return READABLE_CONFIG_SNAPSHOT_FORMATS.includes(version);
}

/** Whether a stored review snapshot's format can be interpreted. */
function readableReviewSnapshot(version: number): boolean {
  return READABLE_REVIEW_SNAPSHOT_FORMATS.includes(version);
}

/** Whether a stored template's format can be interpreted. */
function readableTemplate(version: number): boolean {
  return READABLE_TEMPLATE_FORMATS.includes(version);
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
      : `record format ${String(version)} is newer than this plugin (${String(LATEST_CALL_FORMAT)})`,
  };
}

/**
 * One page of the call list.
 *
 * The paging contract — stable total order, bounded window, narrow projection —
 * belongs to `call-list.ts`; this is the module boundary the store already
 * exposes, kept so the read adapter has one import site for call reads.
 *
 * The detail read (`getCall`) is a separate contract and does return the whole
 * record: the list must not, or a page would carry every call's full prompt and
 * response.
 */
export function listCalls(db: DatabaseSync, filter: CallFilter = {}): CallPage {
  return callPage(db, filter);
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
    templateId:
      typeof model['template_id'] === 'string' ? model['template_id'] : null,
    responseText:
      typeof model['response_text'] === 'string'
        ? model['response_text']
        : null,
    parsed: rowJson(model['parsed']),
    error: typeof model['error'] === 'string' ? model['error'] : null,
    startedAt: rowNumber(model['started_at']),
    durationMs: rowNumber(model['duration_ms']),
    estimatedInputTokens: rowNumber(model['estimated_input_tokens']),
    // Both usage values are returned: the provider's masked payload so a reader can
    // re-normalize it after the mapping version changes, and the normalization this
    // build reads. A null is "the provider reported nothing", never a payload of
    // zeros.
    usage: rowJson(model['usage']),
    normalizedUsage: rowJson(model['normalized_usage']),
  };
}

/**
 * Template content for the identities a detail view references.
 *
 * A `model_calls.template_id` that names no row is reported as absent rather than
 * as an empty template: `model_calls` declares no foreign key, so a dangling
 * reference is representable, and manufacturing a record with `content: null`
 * would tell the reader the template exists and merely has no text.
 */
function templatesFor(
  db: DatabaseSync,
  models: readonly Record<string, unknown>[],
): readonly unknown[] {
  const ids = [
    ...new Set(
      models
        .map((model) => model['template_id'])
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  return ids.map((id) => {
    const value = db
      .prepare(
        'SELECT template_id, content, format_version, renderer_version FROM templates WHERE template_id = ?',
      )
      .get(id);
    if (value === undefined) {
      return {
        templateId: id,
        // No row at all, which is different from a row this build cannot read.
        present: false,
        content: null,
        formatVersion: null,
        rendererVersion: null,
        unreadable: false,
      };
    }
    const row = asRow(value);
    const version = rowNumber(row['format_version'], 1);
    return {
      templateId: id,
      present: true,
      content: readableTemplate(version) ? rowText(row['content']) : null,
      formatVersion: version,
      rendererVersion: rowText(row['renderer_version']),
      unreadable: !readableTemplate(version),
    };
  });
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
    .prepare('SELECT content, format_version FROM snapshots WHERE call_id = ?')
    .get(callId);
  const snapshot = asRow(snapshotValue);
  const snapshotUnreadable = !readableReviewSnapshot(
    rowNumber(snapshot['format_version'], 1),
  );
  const models = asRows(
    db
      .prepare('SELECT * FROM model_calls WHERE call_id = ? ORDER BY attempt')
      .all(callId),
  );
  const configValue = db
    .prepare(
      'SELECT content, format_version FROM config_snapshots WHERE snapshot_id = ?',
    )
    .get(rowText(call['config_snapshot_id']));
  const config = asRow(configValue);
  const configUnreadable = !readableConfigSnapshot(
    rowNumber(config['format_version'], 1),
  );
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
    scores: rowScores(call['scores']),
    reviewStage: rowReviewStage(call['review_stage']),
    usage: rowJson(call['usage']),
    decisionRules: rowStrings(call['decision_rules']),
    executionStatus: rowText(call['execution_status']),
    executionStartedAt: optionalNumber(call['execution_started_at']),
    executionFinishedAt: optionalNumber(call['execution_finished_at']),
    stages: stages.map(stageRow),
    // A structured snapshot written by a newer format is not presented under
    // current semantics: the raw content stays readable, its interpretation is
    // marked unavailable.
    snapshot: snapshotUnreadable ? null : rowJson(snapshot['content']),
    snapshotFormatVersion: rowNumber(snapshot['format_version'], 1),
    snapshotUnreadable,
    modelCalls: models.map(modelCallRow),
    templates: templatesFor(db, models),
    config: configUnreadable ? null : rowJson(config['content']),
    configFormatVersion: rowNumber(config['format_version'], 1),
    configUnreadable,
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
  readonly scores: ReviewScores | null;
  readonly effect: unknown;
  readonly fingerprint: string;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT call_id, ts, tool, arguments, result, execution_status, scores, effect, fingerprint,
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
        scores: rowScores(row['scores']),
        effect: rowJson(row['effect']),
        fingerprint: rowText(row['fingerprint']),
      },
    ];
  });
}

/**
 * Prior verdicts for one session, plus how many rows were excluded for format.
 *
 * Two properties matter beyond the rows themselves:
 *
 * - The filter is in `WHERE`, not applied to a `LIMIT`ed page. Filtering after
 *   the limit would let unreadable rows consume window slots and silently
 *   shorten the result.
 * - `unreadableCount` reports rows this build could not interpret. A caller that
 *   reasons about "this session has no history" must be able to tell a truly
 *   empty session from one whose records exist but cannot be read; both look
 *   like an empty array otherwise.
 *
 * The count is deliberately *not* limited to the window: the caller's question is
 * whether interpretable-but-absent history can be distinguished, and a single
 * unreadable row anywhere in the session answers it. Deleted or expired rows are
 * not counted, because they are genuinely gone rather than unreadable.
 */
export function priorVerdictsForSession(
  db: DatabaseSync,
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
  // The placeholders keep the filter and the JS reader in one definition: the
  // readable formats are decided by `READABLE_CALL_FORMATS`.
  const placeholders = READABLE_CALL_FORMATS.map(() => '?').join(', ');
  const rows = asRows(
    db
      .prepare(
        `SELECT ts, call_id, config_revision, tool, fingerprint, trace, result, reason,
                decision_rules, effect
           FROM calls
          WHERE session_id = ?
            AND result NOT IN ('allow', 'review-allow', 'human-allow')
            AND record_format_version IN (${placeholders})
          ORDER BY ts DESC, call_id DESC
          LIMIT ?`,
      )
      .all(sessionId, ...READABLE_CALL_FORMATS, limit),
  );
  const excluded = asRow(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM calls
          WHERE session_id = ?
            AND result NOT IN ('allow', 'review-allow', 'human-allow')
            AND record_format_version NOT IN (${placeholders})`,
      )
      .get(sessionId, ...READABLE_CALL_FORMATS),
  );
  return {
    unreadableCount: rowNumber(excluded['count']),
    verdicts: rows.map((row) => {
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
    }),
  };
}

export function recentForReplay(
  db: DatabaseSync,
  limit = 200,
): readonly {
  readonly callId: string;
  readonly tool: string;
  readonly scores: ReviewScores;
  readonly result: string;
  readonly reviewStage: ReviewStageRecord | null;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT call_id, tool, scores, result, review_stage, record_format_version
           FROM calls WHERE scores IS NOT NULL ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit),
  );
  return rows.flatMap((row) => {
    if (!readableFormat(formatOf(row))) return [];
    const scores = rowScores(row['scores']);
    // A row whose stored score cannot be interpreted is skipped rather than
    // guessed at: replaying it under the current matrix would report a decision
    // this build never made.
    if (scores === null) return [];
    return [
      {
        callId: rowText(row['call_id']),
        tool: rowText(row['tool']),
        scores,
        result: rowText(row['result']),
        reviewStage: rowReviewStage(row['review_stage']),
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
