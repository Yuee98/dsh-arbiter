/**
 * The single call-detail read, keyed by `callId`.
 *
 * The audit store is the primary source because it alone keeps the full stored
 * material, but it is not required: a call can be explained from the runtime's
 * own memory window or from the session log, which #16 already writes and reads.
 * This module consumes those records as they are — it does not re-select a
 * window, re-frame a chain, or reconstruct material no source stored.
 *
 * Three outcomes are kept distinct, because they mean different things to an
 * operator:
 *
 *   - a full detail from the audit row;
 *   - a partial detail from memory or the session log, with every absent part
 *     reported as a missing code;
 *   - no detail at all, because no available source holds this call.
 */

import type { PriorVerdictItem } from '../types.js';
import { recordOf } from '../records.js';
import type { SessionLike } from '../snapshot.js';
import { auditDetail } from './call-detail-audit.js';
import { reviewStateOf } from './call-detail-trace.js';
import {
  DECISION_RECORD,
  decodeDecisionRecord,
  mergeObservations,
  priorItemOf,
} from './history-record.js';
import type {
  CallDetail,
  CallDetailMissingCode,
  CallDetailStage,
} from './call-detail-types.js';
import type { HostEnvironment } from './types.js';

/** What one read of the detail produced. */
export type CallDetailRead =
  | { readonly kind: 'found'; readonly detail: CallDetail }
  | {
      readonly kind: 'unavailable';
      /** True when a stored structure could not be read, rather than a miss. */
      readonly unreadableStructure: boolean;
    };

/** Where a remembered verdict was found, once it is known. */
interface Remembered {
  readonly item: PriorVerdictItem;
  readonly sessionId: string;
  readonly session: SessionLike | undefined;
}

function verdictOf(items: readonly PriorVerdictItem[]): PriorVerdictItem[] {
  return [...items].sort((left, right) => left.ts - right.ts);
}

/**
 * The newest remembered verdict for this call, from memory first.
 *
 * Memory is authoritative while it holds an entry: it is the runtime's own copy
 * of the decision, and #16 already merged whatever a recovery found into it.
 * Only when memory has nothing is a live session log scanned, and only for this
 * one call id — a bounded lookup, not a second recovery pass.
 */
function remembered(host: HostEnvironment, callId: string): Remembered | null {
  for (const [sessionId, items] of host.runtime.priorVerdicts) {
    const matches = items.filter((item) => item.callId === callId);
    if (matches.length === 0) continue;
    const item = verdictOf(matches).at(-1);
    if (item === undefined) continue;
    // A call id is unique, so the first session holding it is the one that
    // recorded it; a later session's copy would be the same call, not a newer
    // fact about it.
    return {
      item,
      sessionId,
      session: host.services.sessions?.get?.(sessionId),
    };
  }
  return scanSessions(host, callId);
}

/** Look for the call in the committed decision records of live sessions. */
function scanSessions(
  host: HostEnvironment,
  callId: string,
): Remembered | null {
  const sessions = host.services.sessions;
  if (sessions === undefined) return null;
  for (const session of liveSessions(host, sessions)) {
    const item = sessionRecordFor(session, callId);
    if (item !== null)
      return { item, sessionId: session.id ?? 'unknown', session };
  }
  return null;
}

/**
 * The sessions a host can currently name.
 *
 * A runtime that offers `list()` answers directly. One that only offers lookup
 * still holds the sessions this runtime has described, so those ids are tried
 * rather than the whole source being called unreadable. A miss is then an honest
 * "not found here".
 */
function liveSessions(
  host: HostEnvironment,
  sessions: NonNullable<HostEnvironment['services']['sessions']>,
): readonly SessionLike[] {
  const listed = sessions.list?.();
  if (listed !== undefined) return listed;
  if (sessions.get === undefined) return [];
  const ids = new Set([
    ...host.runtime.priorVerdicts.keys(),
    ...host.runtime.historyStatus.keys(),
    ...[...host.runtime.pending.values()].map((entry) => entry.sessionId),
  ]);
  return [...ids].flatMap((id) => {
    const session = sessions.get?.(id);
    return session === undefined ? [] : [session];
  });
}

/**
 * One call's committed decision record inside a session log.
 *
 * Duplicate records of the same logical call are merged rather than the last one
 * winning, so a disagreement between two writes of this call stays visible
 * instead of being silently resolved by read order.
 */
function sessionRecordFor(
  session: SessionLike,
  callId: string,
): PriorVerdictItem | null {
  if (typeof session.snapshotEvents !== 'function') return null;
  let events: readonly {
    seq: number;
    type: string;
    time?: number;
    data?: unknown;
  }[];
  try {
    events = session.snapshotEvents();
  } catch {
    return null;
  }
  let merged: PriorVerdictItem | null = null;
  for (const event of events) {
    const committed = recordOf(event);
    if (committed === undefined || committed.type !== DECISION_RECORD) continue;
    const record = decodeDecisionRecord(committed.data, {
      time: committed.time,
      seq: committed.seq,
    });
    if (record === null || record.callId !== callId) continue;
    const item = priorItemOf(record);
    merged = merged === null ? item : mergeObservations(merged, item);
  }
  return merged;
}

/** The stored stage chain of a remembered verdict, when one was recorded. */
function rememberedChain(
  item: PriorVerdictItem,
): readonly CallDetailStage[] | null {
  if (item.stages === undefined || item.stages.length === 0) return null;
  return item.stages.map((stage, index) => ({
    seq: index,
    stage: stage.stage,
    result: stage.result,
    reason: stage.reason,
    ruleId: stage.ruleId,
    // The session record never stored the rule's display name, so it stays
    // unknown instead of being read from today's configuration.
    ruleName: null,
    decisionRules: stage.decisionRules,
    configRevision: stage.configRevision,
    configSnapshotId: null,
    ts: stage.ts,
  }));
}

/** The session-header facts that describe this call's place. */
function sessionFields(session: SessionLike | undefined): {
  readonly sessionKind: string | null;
  readonly parentSession: string | null;
  readonly cwd: string | null;
} {
  const header = session?.header;
  if (header === undefined)
    return { sessionKind: null, parentSession: null, cwd: null };
  const parent = header.parentSession ?? null;
  return {
    sessionKind: parent === null ? 'main' : 'subagent',
    parentSession: parent,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
  };
}

/**
 * A minimal detail assembled from a remembered verdict.
 *
 * Only what the record actually carries is filled in. A chain of result strings
 * without stored stages is not expanded into stage names, the rule's name is not
 * looked up live, and the execution result stays unknown rather than being
 * inferred from the verdict.
 */
function rememberedDetail(
  found: Remembered,
  missing: readonly CallDetailMissingCode[],
): CallDetail {
  const { item, session } = found;
  const chain = rememberedChain(item);
  const trace = [...item.trace];
  const fields = sessionFields(session);
  const reasons = (chain ?? []).map((stage) => stage.reason);
  const gaps: CallDetailMissingCode[] = [...missing];
  if (chain === null && trace.length > 0) gaps.push('stage-details-missing');
  // A remembered rule has no stored name: the session record does not carry one,
  // and reading it from the live rule list would relabel a past decision.
  if (item.ruleId !== undefined) gaps.push('rule-name-missing');
  // A proven review makes its absent material a real gap; a short-circuit does
  // not, and an unprovable state is left to the reviewState field.
  // A session record keeps result strings only, so it has no stage reasons and no
  // attempt records: the classifier then reports `unknown` wherever the trace
  // cannot prove either way.
  const reviewState = reviewStateOf(trace, chain, 0);
  if (reviewState === 'reviewed')
    gaps.push('snapshot-missing', 'model-attempts-missing');
  gaps.push('execution-not-observed');
  return {
    callId: item.callId,
    source: 'session',
    recordFormatVersion: null,
    unreadable: false,
    unreadableReason: null,
    overview: {
      tool: item.tool,
      ts: item.ts,
      sessionId: found.sessionId,
      sessionKind: fields.sessionKind,
      parentSession: fields.parentSession,
      workspace: null,
      cwd: fields.cwd,
      profile: null,
      approvalMode: null,
      executionMode: null,
      verdict: item.result,
      verdictReason: item.reason ?? null,
      configRevision: item.configRevision,
      fingerprint: item.fingerprint,
      execution: { status: null, startedAt: null, finishedAt: null },
      cancelled:
        item.result === 'human-abort' ||
        reasons.some((reason) => reason === 'approval_cancelled'),
    },
    basis: {
      rule:
        item.ruleId === undefined
          ? null
          : { ruleId: item.ruleId, ruleName: null },
      decisionRules: item.decisionRules ?? [],
      // Both readings travel with the entry; surfacing them is what keeps a
      // disputed verdict from looking like an uncontested one.
      conflicts: item.conflicts ?? [],
      conflictsTruncated: item.conflictsTruncated === true,
      policyStrategy: null,
      chain,
      reviewState,
      trace,
      signals: null,
      evidence: [],
      materials: [],
      evidenceTruncated: false,
      snapshotMissing: [],
      historyStatus: null,
      effect: item.effect === undefined ? null : item.effect,
    },
    raw: {
      arguments: null,
      argumentsSchema: null,
      snapshot: null,
      config: null,
      configFormatVersion: null,
      snapshotFormatVersion: null,
      modelAttempts: [],
      templates: [],
      sessionRecordState: null,
    },
    missing: [...new Set(gaps)],
  };
}

/** Why the audit source could not answer, as a missing code. */
function auditGap(
  host: HostEnvironment,
  callId: string,
):
  | { readonly detail: CallDetail }
  | { readonly gap: CallDetailMissingCode; readonly unreadable: boolean } {
  const audit = host.currentAudit();
  if (audit === null) {
    return {
      gap: host.runtime.config.audit.enabled
        ? 'audit-unavailable'
        : 'audit-disabled',
      unreadable: false,
    };
  }
  const read = audit.readCall(callId);
  // A structure this build cannot interpret is not a missing call; the two are
  // reported with different codes because the operator's next step differs.
  if (read.unreadable) return { gap: 'audit-unreadable', unreadable: true };
  if (read.record !== null) return { detail: auditDetail(read.record) };
  // The store answered and does not hold this call: cleared, trimmed by the
  // retention policy, or written by a different profile's database.
  return { gap: 'audit-record-cleared', unreadable: false };
}

/** Read one call's detail from whichever source actually holds it. */
export function readCallDetail(
  host: HostEnvironment,
  callId: string,
): CallDetailRead {
  const fromAudit = auditGap(host, callId);
  if ('detail' in fromAudit) return { kind: 'found', detail: fromAudit.detail };
  const found = remembered(host, callId);
  if (found !== null) {
    return {
      kind: 'found',
      detail: rememberedDetail(found, [fromAudit.gap]),
    };
  }
  return { kind: 'unavailable', unreadableStructure: fromAudit.unreadable };
}
