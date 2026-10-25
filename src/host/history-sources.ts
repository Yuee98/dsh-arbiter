/**
 * Reading the durable sources that describe a session's prior verdicts.
 *
 * Two sources, two different kinds of evidence. The session log is an ordered
 * event stream, so it knows what came before a reset and can bound itself by
 * position. SQLite is a table, so it knows times and results but not position,
 * and its window query filters allowed results out — both of which shape how its
 * rows may be used. Each read reports what it could *not* establish, so a caller
 * never has to infer "nothing was there" from an empty list.
 */
import {
  DECISION_RECORD,
  HISTORY_RESET_RECORD,
  asCallResult,
  decodeDecisionRecord,
  isPriorVerdictCandidate,
  priorItemOf,
  comparePriorVerdicts,
  mergeObservations,
} from './history-record.js';
import type { HostEnvironment } from './types.js';
import type { HistorySourceState, PriorVerdictItem } from '../types.js';
import type { SessionEventLike } from '../snapshot.js';
import { recordOf } from '../records.js';

/** The time an explicit reset record carries, or `null` when it has none. */
export function resetTimestamp(
  data: unknown,
  time: number | undefined,
): number | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return time ?? null;
  }
  const at: unknown = Reflect.get(data, 'at');
  if (typeof at === 'number') return at;
  return time ?? null;
}

/**
 * The stored stage chain for one call, when the audit store can supply it.
 *
 * The projection a window read returns reduces stages to their result strings,
 * which is enough to order and dedupe but loses the reason, the rule and the
 * time each stage actually recorded. Recovery reads the real rows for the few
 * candidates it keeps; a failure here degrades to "no richer stages" instead of
 * failing the whole history.
 */
function stagesFor(
  audit: { priorVerdictStages?: (callId: string) => readonly StoredStage[] },
  callId: string,
): readonly StoredStage[] | undefined {
  const read = audit.priorVerdictStages;
  if (typeof read !== 'function') return undefined;
  try {
    const stages = read.call(audit, callId);
    return stages.length === 0 ? undefined : stages;
  } catch {
    return undefined;
  }
}

/** Carry the stage chain only when a source actually supplied one. */
function stagesField(
  stages: readonly StoredStage[] | undefined,
): { readonly stages: readonly StoredStage[] } | Record<string, never> {
  return stages === undefined ? {} : { stages };
}

/** One stored stage as the audit store reports it. */
interface StoredStage {
  readonly stage: string;
  readonly result: string;
  readonly reason: string | null;
  readonly ruleId: string | null;
  readonly decisionRules: readonly string[];
  readonly configRevision: string | null;
  readonly ts: number;
}

/** What one source could contribute to a recovery read. */
export interface SourceRead {
  readonly items: readonly PriorVerdictItem[];
  readonly unavailable: string | null;
  /**
   * Whether this source alone held more rows than the window.
   *
   * A durable source that could return more than the window proves the window
   * cut real history, which the merged population alone cannot show.
   */
  readonly overflow?: boolean;
  /**
   * Records that looked like decisions but could not be interpreted.
   *
   * Such a record is proof that this source holds a decision we failed to read,
   * so a window built without it cannot be called complete.
   */
  readonly invalid?: number;
  /**
   * Observations this source recorded that the candidate filter rejects, kept
   * only for calls that also have an eligible observation.
   *
   * They exist so a cross-source contradiction cannot be hidden: if one source
   * says allow and the other says deny for the same call, the allow observation
   * must reach the merger or the surviving deny looks uncontested.
   */
  readonly excluded?: readonly PriorVerdictItem[];
  /** Logical calls this source observed as eligible candidates. */
  readonly eligibleIds?: readonly string[];
  /** The reset instant this source itself recorded, when it recorded one. */
  readonly resetAt?: number | null;
}

/** A source that answered with no rows: not a failure, an empty answer. */
export const ANSWERED: HistorySourceState = { read: 0, unavailable: null };

export function sourceState(read: SourceRead): HistorySourceState {
  return { read: read.items.length, unavailable: read.unavailable };
}

/** Whether any durable source observed more rows than the window kept. */
export function anyOverflow(session: SourceRead, audit: SourceRead): boolean {
  return session.overflow === true || audit.overflow === true;
}

export function unavailableSource(reason: string): SourceRead {
  return { items: [], unavailable: reason };
}

/**
 * Read this session's decision records, and its reset barrier if it has one.
 *
 * One pass over the log, retaining at most the window plus one candidate: the
 * host's `snapshotEvents()` already materializes the event array, so re-walking
 * it for a second fact would double the only cost this layer controls, and
 * keeping every decision seen would make a long session's memory grow with its
 * history rather than with the configured window.
 *
 * Only the current session is asked. A parent's or sibling's verdicts are a
 * different history, and the parent's own words already arrive as evidence.
 */
export function readSession(
  host: HostEnvironment,
  sessionId: string,
  limit: number,
): SourceRead {
  const sessions = host.services.sessions;
  if (sessions?.get === undefined) {
    return unavailableSource('the host exposes no session lookup');
  }
  const session = sessions.get(sessionId);
  if (session === undefined) {
    return unavailableSource('the session is not live in this host');
  }
  if (typeof session.snapshotEvents !== 'function') {
    return unavailableSource('the session exposes no readable event log');
  }
  let events: readonly SessionEventLike[];
  try {
    events = session.snapshotEvents();
  } catch (error) {
    return unavailableSource(
      error instanceof Error ? error.message : String(error),
    );
  }
  const scan = scanDecisionRecords(events, limit);
  if (scan.resetAt !== null) {
    // A stored barrier may be older than one this runtime already applied. The
    // newer reset is the current intent, so an older record must not replace it
    // — otherwise a failed second reset would be undone by reading the first.
    const known = host.runtime.historyReset.get(sessionId);
    if (known === undefined || scan.resetAt > known) {
      host.runtime.historyReset.set(sessionId, scan.resetAt);
    }
  }
  return {
    items: scan.items,
    unavailable: null,
    overflow: scan.truncated,
    invalid: scan.invalid,
    excluded: scan.bypassed,
    resetAt: scan.resetAt,
  };
}

/**
 * Scan one session log for decisions, bounded to the window throughout.
 *
 * One pass in event order, because that order is the only evidence of what came
 * before a reset. Everything retained is capped at the window:
 *
 *   - `items`: eligible verdicts, deduplicated by logical call and ordered by
 *     the shared comparator.
 *   - `truncated`: a monotone flag set when a distinct call had to be dropped
 *     to keep that cap. It is never recomputed from the retained set, because a
 *     trimmed set cannot show what it lost; duplicate records of one call never
 *     set it, because they add no distinct call.
 *   - `resetAt`: the newest reset record seen, so a caller can tell whether the
 *     log itself bounded the items.
 *
 * Rejected observations are *not* retained here. Keeping every allow in a long
 * session would cost the session's history rather than the window, and the
 * cross-source contradiction they exist for is looked up per window entry
 * afterwards, where it is bounded by N.
 */
function scanDecisionRecords(
  events: readonly SessionEventLike[],
  limit: number,
): {
  readonly items: PriorVerdictItem[];
  readonly bypassed: readonly PriorVerdictItem[];
  readonly truncated: boolean;
  readonly resetAt: number | null;
  /** Decision records this build could not interpret. */
  readonly invalid: number;
} {
  const bounded = Math.max(1, limit);
  // Newest N distinct calls, keyed by call id. `truncated` is monotone: once a
  // call has been dropped, no later observation can undo that fact.
  const kept = new Map<string, PriorVerdictItem>();
  // Rejected observations for calls that are currently in the window, so the
  // same source's own disagreement is still visible. Capped by the window.
  const bypassed = new Map<string, PriorVerdictItem>();
  let truncated = false;
  let resetAt: number | null = null;
  let invalid = 0;
  for (const event of events) {
    const committed = recordOf(event);
    if (committed === undefined) continue;
    if (committed.type === HISTORY_RESET_RECORD) {
      const at = resetTimestamp(committed.data, committed.time);
      if (at !== null) {
        // A reset withdraws everything committed before it, and event order is
        // the authoritative evidence for that. It also clears the capacity fact:
        // the withdrawn history was not "trimmed out of the window".
        resetAt = at;
        kept.clear();
        bypassed.clear();
        truncated = false;
      }
      continue;
    }
    if (committed.type !== DECISION_RECORD) continue;
    const record = decodeDecisionRecord(committed.data, {
      time: committed.time,
      seq: committed.seq,
    });
    if (record === null) {
      // A record this build cannot interpret is evidence that the log holds a
      // decision we failed to read, so it is counted rather than skipped.
      invalid += 1;
      continue;
    }
    const item = priorItemOf(record);
    const existing = kept.get(item.callId);
    if (!isPriorVerdictCandidate(item.result)) {
      // An observation of a call the window holds still matters: the merger
      // needs both readings to report rather than resolve the contradiction.
      if (existing !== undefined) bypassed.set(item.callId, item);
      continue;
    }
    bypassed.delete(item.callId);
    kept.set(
      item.callId,
      existing === undefined ? item : mergeObservations(existing, item),
    );
    while (kept.size > bounded) {
      // Drop the oldest distinct call. This is a real capacity cut, and the
      // flag records it even though the dropped entry is gone.
      const oldest = [...kept.values()].sort(comparePriorVerdicts)[0];
      if (oldest === undefined) break;
      kept.delete(oldest.callId);
      bypassed.delete(oldest.callId);
      truncated = true;
    }
  }
  return {
    items: [...kept.values()].sort(comparePriorVerdicts),
    bypassed: [...bypassed.values()],
    truncated,
    resetAt,
    invalid,
  };
}

/**
 * Read the audit store's view of the same session.
 *
 * A disabled or failed store is reported rather than treated as "no rows":
 * the two look identical in a result set but mean opposite things.
 */
export function readAudit(
  host: HostEnvironment,
  sessionId: string,
  limit: number,
): SourceRead {
  const audit = host.currentAudit();
  if (audit === null) {
    return unavailableSource(
      host.runtime.config.audit.enabled
        ? 'audit storage is currently unavailable'
        : 'the audit store is disabled',
    );
  }
  let invalid = 0;
  try {
    // One row beyond the window: the audit store applies its own SQL LIMIT, so
    // asking for exactly N makes "exactly N exist" and "N were cut from more"
    // indistinguishable. The extra row is discarded after it proves the cut.
    const read = audit.priorVerdictsForSession(sessionId, limit + 1);
    // Rows the store excluded because this build cannot read their format are
    // decisions that exist and cannot be used. Counting them is what stops an
    // empty window from being reported as an empty history: "nothing to show"
    // and "nothing that can be read" are different facts.
    invalid += read.unreadableCount;
    const items = read.verdicts.flatMap((row): PriorVerdictItem[] => {
      // An unrecognized stored result is not silently mapped onto a real
      // verdict, and it is not silently dropped either: the row exists, so it
      // is evidence of a decision this build cannot interpret.
      const result = asCallResult(row.result);
      if (result === null) {
        invalid += 1;
        return [];
      }
      return [
        {
          ts: row.ts,
          callId: row.callId,
          configRevision: row.configRevision,
          tool: row.tool,
          fingerprint: row.fingerprint,
          trace: row.trace,
          result,
          ...(row.reason === '' ? {} : { reason: row.reason }),
          ...(row.ruleId === null ? {} : { ruleId: row.ruleId }),
          decisionRules: row.decisionRules,
          ...stagesField(stagesFor(audit, row.callId)),
        },
      ];
    });
    return {
      items: items.slice(0, limit),
      unavailable: null,
      overflow: items.length > limit,
      invalid,
    };
  } catch (error) {
    return unavailableSource(
      error instanceof Error ? error.message : String(error),
    );
  }
}
