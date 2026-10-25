/**
 * Reads that complete a recovered verdict from real stored evidence.
 *
 * These exist for history recovery, not for the audit UI. They are separated from
 * `queries.ts` so the audit module keeps one responsibility per file and the
 * recovery-specific reads stay visible as a small, reviewable surface.
 *
 * Both are keyed reads: `priorVerdictStages` for one call's stage chain, and
 * `verdictsForCalls` for an already selected id set. Neither takes a window, so
 * neither can silently shorten a result the way a `LIMIT` would.
 */
/** The database handle, kept structural so declarations never name the driver. */
interface ReadableDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}

/** The stored-shape contract these reads return, free of the driver's types. */
export type StoredStage = {
  readonly stage: string;
  readonly result: string;
  readonly reason: string | null;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
  readonly configRevision: string | null;
  readonly ts: number;
};

export type StoredVerdict = {
  readonly callId: string;
  readonly ts: number;
  readonly configRevision: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly trace: readonly string[];
  readonly result: string;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
};

import { asRows, rowNumber, rowStrings, rowText, rowTrace } from './rows.js';

/**
 * The full stored stage chain for one call.
 *
 * `priorVerdictsForSession` projects stages down to their result strings, which
 * is enough for the review prompt but not for completing a chain that another
 * source only partly recorded. This reads the real rows — stage name, result,
 * reason, rule and the decision rules the stage applied — for the few calls a
 * recovery actually needs, without changing the existing projection.
 */
/**
 * Bind the completion reads to one database handle.
 *
 * The handle is captured here rather than passed through the exported surface, so
 * the published declarations never mention the SQLite driver's types. A consumer of
 * this module asks for reads, not for a database.
 */
export function storedReads(db: ReadableDb): {
  readonly stages: (callId: string) => readonly StoredStage[];
  readonly calls: (
    sessionId: string,
    callIds: readonly string[],
  ) => readonly StoredVerdict[];
} {
  return {
    stages: (callId) => readStages(db, callId),
    calls: (sessionId, callIds) => readCalls(db, sessionId, callIds),
  };
}

function readStages(
  db: ReadableDb,
  callId: string,
): readonly {
  readonly stage: string;
  readonly result: string;
  readonly reason: string | null;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
  readonly configRevision: string | null;
  readonly ts: number;
}[] {
  const rows = asRows(
    db
      .prepare(
        `SELECT stage, result, reason, rule_id, decision_rules, config_revision, ts
           FROM stages WHERE call_id = ? ORDER BY seq`,
      )
      .all(callId),
  );
  return rows.map((row) => ({
    stage: rowText(row['stage']),
    result: rowText(row['result']),
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
    ruleId: typeof row['rule_id'] === 'string' ? row['rule_id'] : null,
    decisionRules: rowStrings(row['decision_rules']),
    configRevision:
      typeof row['config_revision'] === 'string'
        ? row['config_revision']
        : null,
    ts: rowNumber(row['ts']),
  }));
}

/**
 * The stored result of specific calls, whatever it is.
 *
 * `priorVerdictsForSession` filters allowed results out of the window, which is
 * correct for selection but hides the case where SQLite holds an `allow` for a
 * call the session record denies. Recovery needs that reading to report the
 * contradiction rather than present an uncontested deny, so this reads exactly
 * the candidate ids the window already selected — a bounded lookup, not a second
 * window query.
 */
function readCalls(
  db: ReadableDb,
  sessionId: string,
  callIds: readonly string[],
): readonly {
  readonly callId: string;
  readonly ts: number;
  readonly configRevision: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly trace: readonly string[];
  readonly result: string;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
}[] {
  if (callIds.length === 0) return [];
  const placeholders = callIds.map(() => '?').join(', ');
  const rows = asRows(
    db
      .prepare(
        `SELECT ts, call_id, config_revision, tool, fingerprint, trace, result, reason, decision_rules
           FROM calls WHERE session_id = ? AND call_id IN (${placeholders})`,
      )
      .all(sessionId, ...callIds),
  );
  return rows.map((row) => {
    const trace = rowTrace(row['trace']);
    const rule = trace.find((stage) => stage.stage === 'rule');
    return {
      callId: rowText(row['call_id']),
      ts: rowNumber(row['ts']),
      configRevision: rowText(row['config_revision']),
      tool: rowText(row['tool']),
      fingerprint: rowText(row['fingerprint']),
      trace: trace.map((stage) => stage.result),
      result: rowText(row['result']),
      reason: rowText(row['reason']),
      ruleId: rule?.ruleId ?? null,
      decisionRules: rowStrings(row['decision_rules']),
    };
  });
}
