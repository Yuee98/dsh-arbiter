/**
 * Prior-verdict history: the runtime window, its cold recovery, and the facts
 * that describe how complete it is.
 *
 * The window is defined once, in `history-record.ts`, and every source feeds the
 * same selector. Three rules follow from that:
 *
 *   - memory is authoritative while it holds the session's history, and it never
 *     waits for persistence: a written record is a durable copy, not a
 *     precondition for the next review;
 *   - a recovery read is a bounded snapshot merged into whatever memory holds
 *     now, so a result computed earlier can never replace a newer entry;
 *   - a source that could not answer, a window that dropped candidates, an
 *     incomplete chain and a genuine disagreement are all reported instead of
 *     being flattened into an empty history.
 *
 * Recovered and live entries share one identity (`callId`), so a call occupies
 * the window once no matter how many sources saw it.
 */

import {
  DECISION_RECORD,
  HISTORY_RESET_RECORD,
  asCallResult,
  decodeDecisionRecord,
  isPriorVerdictCandidate,
  mergeObservations,
  priorItemOf,
  selectWindow,
} from './history-record.js';
import {
  ANSWERED,
  anyOverflow,
  readAudit,
  readSession,
  sourceState,
} from './history-sources.js';
import type { SourceRead } from './history-sources.js';
import { appendRecord } from '../records.js';
import type { HistoryStatus, PriorVerdictItem } from '../types.js';
import type { SessionEventLike, SessionLike } from '../snapshot.js';
import type { HostEnvironment } from './types.js';
import { recordOf } from '../records.js';

export class DecisionHistory {
  private readonly host: HostEnvironment;
  constructor(host: HostEnvironment) {
    this.host = host;
  }

  breakerOpen(sessionId: string): boolean {
    const { runtime } = this.host;
    if (runtime.config.breaker.mode === 'off') return false;
    const breaker = runtime.breakers.get(sessionId);
    if (breaker === undefined) return false;
    const now = Date.now();
    const window = breaker.denials.filter((ts) => now - ts < 60 * 60 * 1_000);
    breaker.denials.splice(0, breaker.denials.length, ...window);
    const preset =
      runtime.config.breaker.mode === 'custom'
        ? {
            consecutive: runtime.config.breaker.consecutiveDenials,
            window: runtime.config.breaker.windowDenials,
            size: runtime.config.breaker.windowSize,
          }
        : runtime.config.breaker.preset === 'strict'
          ? { consecutive: 2, window: 4, size: 10 }
          : runtime.config.breaker.preset === 'lenient'
            ? { consecutive: 5, window: 10, size: 20 }
            : { consecutive: 3, window: 6, size: 10 };
    let consecutive = 0;
    for (let index = breaker.denials.length - 1; index >= 0; index -= 1) {
      consecutive += 1;
      if (index === 0) break;
    }
    return (
      consecutive >= preset.consecutive ||
      breaker.denials.filter((ts) => now - ts < 30 * 60 * 1_000).length >=
        preset.window
    );
  }

  noteDenial(sessionId: string): void {
    const { runtime } = this.host;
    const breaker = runtime.breakers.get(sessionId) ?? { denials: [] };
    breaker.denials.push(Date.now());
    runtime.breakers.set(sessionId, breaker);
  }

  resetBreaker(sessionId: string): void {
    const { runtime } = this.host;
    runtime.breakers.delete(sessionId);
  }

  /**
   * Record one live verdict.
   *
   * The live path never waits for persistence and never asks a source: the
   * verdict it just settled is the newest fact about this session. The window is
   * re-selected rather than appended to, so the same identity rules apply to
   * memory as to recovery, and a re-settled call replaces its earlier entry
   * instead of consuming a second slot.
   */
  rememberPrior(sessionId: string, item: PriorVerdictItem): void {
    const { runtime } = this.host;
    const limit = Math.max(1, runtime.config.context.historyMaxItems);
    const existing = runtime.priorVerdicts.get(sessionId) ?? [];
    const { selected, truncated } = selectWindow([...existing, item], limit);
    runtime.priorVerdicts.set(sessionId, selected);
    // The published status is recomputed, not carried forward. A live verdict
    // cannot make an unreadable source readable, but it does change what the
    // window is: an empty-history claim stops being true the moment memory holds
    // a verdict, and a write that just failed is a gap the next review must see.
    // Recomputing here keeps the in-memory path subject to the same reason
    // aggregation as recovery, instead of the two drifting apart.
    runtime.historyStatus.set(
      sessionId,
      this.inMemoryStatus(sessionId, selected, truncated),
    );
  }

  /**
   * The status for a window this runtime assembled itself.
   *
   * Recovery is skipped whenever memory holds entries, so this is the only place
   * an in-memory window gets its facts. It applies the same rules as the recovery
   * path — every reason that is true of the runtime, the capacity cut, and the
   * reset flag — but reads no durable source, because a live verdict must not
   * wait on storage.
   *
   * The write-failure channel matters here specifically: `sessionRecordFailures`
   * is set when a settlement could not persist its record, and a review that
   * never recovers would otherwise never learn about it. That would report the
   * history as complete while the durable source is known to be missing a
   * decision, which is the exact inversion this issue exists to prevent.
   */
  private inMemoryStatus(
    sessionId: string,
    selected: readonly PriorVerdictItem[],
    truncated: boolean,
  ): HistoryStatus {
    const previous = this.host.runtime.historyStatus.get(sessionId);
    // Reasons that are properties of this runtime, not of a source read. Source
    // unavailability is deliberately not inferred here: no read happened, so
    // claiming a source is unreadable would be a guess. The write failure and the
    // boundary ambiguity are facts this runtime established.
    const reasons = this.windowReasons(sessionId, selected);
    // A window with entries is never "known-empty", whatever an earlier read
    // concluded: the entries are the evidence that such a verdict exists.
    const coverage =
      reasons.length > 0
        ? 'partial'
        : selected.length === 0
          ? 'known-empty'
          : 'complete';
    return {
      coverage,
      windowTruncated: truncated || previous?.windowTruncated === true,
      reason: reasons.length > 0 ? reasons.join('; ') : null,
      // These describe what this runtime knows about its own memory, not a source
      // read, so the counts are its own window.
      sources: {
        memory: { read: selected.length, unavailable: null },
        session: previous?.sources.session ?? ANSWERED,
        audit: previous?.sources.audit ?? ANSWERED,
      },
      reset: previous?.reset ?? this.host.runtime.historyReset.has(sessionId),
    };
  }

  /**
   * Reasons that apply to any window, however it was assembled.
   *
   * A failed record write, a reset boundary that cannot be placed, a
   * cross-source disagreement and truncated conflict evidence are all facts about
   * this session rather than about one particular read. Sharing them is what keeps
   * the in-memory and recovery paths from reporting different completeness for the
   * same window.
   */
  private windowReasons(
    sessionId: string,
    selected: readonly PriorVerdictItem[],
  ): string[] {
    const reasons: string[] = [];
    const writeFailure = this.host.runtime.sessionRecordFailures.get(sessionId);
    if (writeFailure !== undefined) {
      reasons.push(
        `a decision could not be written to the session log (${writeFailure})`,
      );
    }
    const ambiguity = this.host.runtime.historyBoundaryAmbiguity.get(sessionId);
    if (ambiguity !== undefined) reasons.push(ambiguity);
    if (selected.some((item) => (item.conflicts ?? []).length > 0)) {
      reasons.push(
        'some entries carry stages or results that two sources disagree on, and both readings are shown',
      );
    }
    const truncatedConflicts = selected.filter(
      (item) => item.conflictsTruncated === true,
    ).length;
    if (truncatedConflicts > 0) {
      reasons.push(
        `conflict evidence for ${String(truncatedConflicts)} call(s) exceeded what one entry can show, so only the first readings are kept`,
      );
    }
    return reasons;
  }

  /**
   * The prior-verdict window for one session, recovering on first use.
   *
   * Memory wins whenever it holds entries: a recovery read observes storage as
   * it was, and merging that into newer memory would let an older picture win.
   * With no memory, both durable sources are read once, merged by identity and
   * trimmed by the same selector the live path uses.
   *
   * A thin wrapper over {@link windowFor} for callers that only need the items;
   * a review uses the combined result so its entries and its completeness claim
   * describe the same observation.
   */
  priorFor(sessionId: string): PriorVerdictItem[] {
    return this.windowFor(sessionId).items;
  }

  /**
   * The window and the facts about it, read at one point in time.
   *
   * A review must not read the entries and the diagnostics separately: another
   * call on the same session can change the runtime state in between, and the
   * snapshot would then describe a window it never received.
   */
  windowFor(sessionId: string): {
    readonly items: PriorVerdictItem[];
    readonly status: HistoryStatus;
  } {
    const items = this.selectWindowFor(sessionId);
    return { items, status: this.status(sessionId) };
  }

  private selectWindowFor(sessionId: string): PriorVerdictItem[] {
    const { runtime } = this.host;
    const limit = Math.max(1, runtime.config.context.historyMaxItems);
    const inMemory = runtime.priorVerdicts.get(sessionId) ?? [];
    if (inMemory.length > 0) {
      const { selected } = selectWindow(inMemory, limit);
      return selected;
    }
    // A session is recovered once per runtime. Re-reading every call would turn
    // an unavailable source into an unbounded retry, and would let a later read
    // re-open a window this runtime already decided.
    if (runtime.historyRecovered.has(sessionId)) return [];
    // The session log is read first because it is also where a reset barrier
    // lives. Checking the in-memory map before this read would miss a barrier
    // written before the restart and resurrect the history it withdrew.
    const session = readSession(this.host, sessionId, limit);
    if (this.resetBarrier(sessionId) !== null) {
      // The barrier bounds the recovery: only verdicts settled *after* it may be
      // selected, so a session that keeps working after a reset still shows its
      // new history instead of staying permanently empty.
      const afterReset = readAudit(this.host, sessionId, limit);
      const barrier = this.resetBarrier(sessionId);
      return this.recover(sessionId, session, afterReset, limit, barrier);
    }
    const audit = readAudit(this.host, sessionId, limit);
    return this.recover(sessionId, session, audit, limit);
  }

  /**
   * Whether this session's only recorded outcome is the reset itself.
   *
   * Then the empty window is the documented result of the reset rather than a
   * gap: nothing was withheld and nothing is unknown.
   */
  private resetOnlyHistory(sessionId: string): boolean {
    const session = this.host.services.sessions?.get?.(sessionId);
    if (session === undefined || typeof session.snapshotEvents !== 'function') {
      return false;
    }
    let events: readonly SessionEventLike[];
    try {
      events = session.snapshotEvents();
    } catch {
      return false;
    }
    // Scan back to the LAST reset barrier, not forward from the first. With
    // several resets, a decision between them was already withdrawn by the later
    // one, so returning false at the first decision after T1 would misclassify a
    // legitimately empty interval.
    let sawLatestReset = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) continue;
      const committed = recordOf(event);
      if (committed === undefined) continue;
      if (committed.type === HISTORY_RESET_RECORD) {
        sawLatestReset = true;
        break;
      }
      // A decision committed after the latest barrier means the interval is not
      // empty, so this is not a reset-only history.
      if (committed.type === DECISION_RECORD) return false;
    }
    return sawLatestReset;
  }

  /** Whether this session's runtime window currently holds any verdict. */
  hasWindow(sessionId: string): boolean {
    return (this.host.runtime.priorVerdicts.get(sessionId) ?? []).length > 0;
  }

  /**
   * Record that a decision could not be written to this session's log.
   *
   * A failed write is a real gap in the session-record source, not a logging
   * detail: a later recovery cannot see the verdict at all, and reporting the
   * history as complete would hide that. The gap is consulted both by a recovery
   * read and by the in-memory status, so a review learns about it either way.
   */
  noteRecordFailure(sessionId: string, reason: string): void {
    this.host.runtime.sessionRecordFailures.set(sessionId, reason);
    // Republish immediately for a window already in memory: no recovery will run
    // for it, so waiting for one would mean the warning never appears.
    if (this.hasWindow(sessionId)) this.republishInMemoryStatus(sessionId);
  }

  /**
   * Forget a previously reported write failure for this session.
   *
   * The published status is republished for the same reason it is republished
   * when the failure is recorded: no recovery runs for a window in memory, so a
   * status that still says "incomplete" would outlive the condition that caused
   * it and keep warning about a gap that has since been written.
   */
  clearRecordFailure(sessionId: string): void {
    const had = this.host.runtime.sessionRecordFailures.delete(sessionId);
    if (had && this.hasWindow(sessionId))
      this.republishInMemoryStatus(sessionId);
  }

  /**
   * Recompute the published status of a window this runtime already holds.
   *
   * Only the in-memory window is consulted: this never reads a durable source, so
   * it cannot delay a settlement and cannot resurrect a verdict a reset withdrew.
   */
  private republishInMemoryStatus(sessionId: string): void {
    const limit = Math.max(1, this.host.runtime.config.context.historyMaxItems);
    const { selected, truncated } = selectWindow(
      this.host.runtime.priorVerdicts.get(sessionId) ?? [],
      limit,
    );
    this.host.runtime.historyStatus.set(
      sessionId,
      this.inMemoryStatus(sessionId, selected, truncated),
    );
  }

  /** The status of the last window this session was given. */
  status(sessionId: string): HistoryStatus {
    const known = this.host.runtime.historyStatus.get(sessionId);
    if (known !== undefined) return known;
    // No status has been published for this session yet, but a fact may already
    // be true of it — a settlement can record a failure without a window having
    // been read since. Deriving through the same reason aggregation keeps this
    // fallback from claiming a completeness the runtime cannot support.
    const limit = Math.max(1, this.host.runtime.config.context.historyMaxItems);
    const { selected, truncated } = selectWindow(
      this.host.runtime.priorVerdicts.get(sessionId) ?? [],
      limit,
    );
    return this.inMemoryStatus(sessionId, selected, truncated);
  }

  /**
   * Forget this session's runtime history, and keep it forgotten.
   *
   * The reset is a lifecycle decision, not a storage cleanup, so it has to
   * survive the process: clearing a map alone would be undone by the next
   * restart, which would find both durable sources still holding the withdrawn
   * verdicts. The barrier is written through the public record writer and, when
   * that write is unavailable, the in-memory barrier still applies for this
   * runtime — with the failure surfaced as a gap rather than claimed as durable.
   */
  resetSession(sessionId: string, session?: SessionLike): void {
    const { runtime } = this.host;
    runtime.priorVerdicts.delete(sessionId);
    runtime.historyRecovered.delete(sessionId);
    const at = Date.now();
    runtime.historyReset.set(sessionId, at);
    runtime.historyStatus.set(sessionId, {
      coverage: 'known-empty',
      windowTruncated: false,
      reason: null,
      sources: { memory: ANSWERED, session: ANSWERED, audit: ANSWERED },
      reset: true,
    });
    const target = session ?? this.host.services.sessions?.get?.(sessionId);
    if (target === undefined) return;
    const state = appendRecord(target, HISTORY_RESET_RECORD, { at });
    if (state !== 'written') {
      this.noteRecordFailure(sessionId, state);
    }
  }

  /**
   * When this session's log says its runtime history was reset, if it does.
   *
   * The barrier is recorded while the session log is read, so this answer comes
   * from either the live runtime or that read — never from a second walk of the
   * log.
   */
  private resetBarrier(sessionId: string): number | null {
    return this.host.runtime.historyReset.get(sessionId) ?? null;
  }

  /**
   * Whether this session is provably new, rather than merely empty right now.
   *
   * The only cheap positive evidence is a session with no committed events at
   * all: nothing has happened in it, so nothing can have been lost. Any other
   * session may have had decisions trimmed or cleaned, and an empty result there
   * is "not found", not "never happened".
   */
  private knownEmptyIsProvable(sessionId: string): boolean {
    const session = this.host.services.sessions?.get?.(sessionId);
    if (session === undefined || typeof session.snapshotEvents !== 'function') {
      return false;
    }
    let events: readonly SessionEventLike[];
    try {
      events = session.snapshotEvents();
    } catch {
      return false;
    }
    // The evidence is "this session has no decision history", not "this session's
    // log is empty". The plugin's own admission record is bookkeeping, and every
    // managed session has one; counting it as evidence would make the first review
    // of a genuinely new session claim its history is unknown.
    return !events.some((event) => {
      const committed = recordOf(event);
      return committed !== undefined && committed.type === DECISION_RECORD;
    });
  }

  /**
   * Record that a stored row sits exactly on a reset boundary.
   *
   * SQLite knows a row's time but not its position relative to the reset, so a
   * row stamped in the same millisecond cannot be placed with confidence. It is
   * kept — dropping a real verdict is worse than showing one that may predate the
   * reset — and the read says its coverage is limited rather than claiming a
   * complete history.
   */
  private noteBoundaryAmbiguity(sessionId: string, count: number): void {
    this.host.runtime.historyBoundaryAmbiguity.set(
      sessionId,
      `${String(count)} audit row(s) share the reset instant, so whether they predate the reset cannot be determined`,
    );
  }

  /**
   * Both sources' readings for the calls the window can contain.
   *
   * Each window query filters allowed results out, which is right for selection
   * and wrong for consistency: an `allow` on one side facing a `deny` on the other
   * is exactly the disagreement the design forbids resolving by choosing one. The
   * lookup asks for the selected ids directly, so it costs at most N reads on each
   * side and never scans the history again.
   */
  private crossSourceContradictions(
    sessionId: string,
    selected: readonly PriorVerdictItem[],
  ): PriorVerdictItem[] {
    if (selected.length === 0) return [];
    const ids = [...new Set(selected.map((item) => item.callId))];
    return [
      ...this.auditReadings(sessionId, ids),
      ...this.sessionReadings(sessionId, ids),
    ];
  }

  /** The audit store's reading of specific calls, including allowed results. */
  private auditReadings(
    sessionId: string,
    ids: readonly string[],
  ): PriorVerdictItem[] {
    const audit = this.host.currentAudit();
    if (audit === null) return [];
    let rows: ReturnType<typeof audit.verdictsForCalls>;
    try {
      rows = audit.verdictsForCalls(sessionId, ids);
    } catch {
      return [];
    }
    const items: PriorVerdictItem[] = [];
    for (const row of rows) {
      const result = asCallResult(row.result);
      if (result === null) continue;
      items.push({
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
      });
    }
    return items;
  }

  /**
   * The session log's reading of specific calls, including rejected results.
   *
   * The scan does not retain rejected observations — that would cost the session's
   * history rather than the window — so they are recovered here for the bounded id
   * set the window holds. The lookup is a filter over the event list the caller
   * already materialized, so it allocates only the matching items.
   */
  private sessionReadings(
    sessionId: string,
    ids: readonly string[],
  ): PriorVerdictItem[] {
    const session = this.host.services.sessions?.get?.(sessionId);
    if (session === undefined || typeof session.snapshotEvents !== 'function') {
      return [];
    }
    let events: readonly SessionEventLike[];
    try {
      events = session.snapshotEvents();
    } catch {
      return [];
    }
    const wanted = new Set(ids);
    // One entry per target call, not one per record. A session may hold any number
    // of observations of the same logical call — the issue requires deduplicating
    // them — so appending each match would make the working set grow with the
    // duplicate count rather than with the window.
    const aggregated = new Map<string, PriorVerdictItem>();
    for (const event of events) {
      const committed = recordOf(event);
      if (committed === undefined || committed.type !== DECISION_RECORD) {
        continue;
      }
      const record = decodeDecisionRecord(committed.data, {
        time: committed.time,
        seq: committed.seq,
      });
      if (record === null || !wanted.has(record.callId)) continue;
      if (isPriorVerdictCandidate(record.result)) continue;
      const item = priorItemOf(record);
      const existing = aggregated.get(item.callId);
      // Merged, not overwritten: if the duplicates disagree, the disagreement
      // survives as a conflict instead of the last record winning.
      aggregated.set(
        item.callId,
        existing === undefined ? item : mergeObservations(existing, item),
      );
    }
    return [...aggregated.values()];
  }

  /**
   * Whether the log's own reset is the barrier currently in effect.
   *
   * Only then does event order bound the items, so only then may the timestamp
   * filter be skipped. If this runtime applied a newer reset — because a second
   * reset's record could not be written — the log's older barrier is not the
   * boundary, and the items must be filtered by the current instant.
   */
  private sessionKnowsBarrier(sessionId: string, session: SourceRead): boolean {
    if (session.resetAt === null || session.resetAt === undefined) return false;
    return this.host.runtime.historyReset.get(sessionId) === session.resetAt;
  }

  /** Merge the durable reads into the window, and describe what happened. */
  private recover(
    sessionId: string,
    session: SourceRead,
    audit: SourceRead,
    limit: number,
    barrier: number | null = null,
  ): PriorVerdictItem[] {
    const { runtime } = this.host;
    // A reset withdraws everything committed before it, and the two sources know
    // that differently. The session log carries the reset as an event, so its own
    // scan already bounded the items by event order — the only authoritative
    // answer, and the only one that keeps a verdict committed in the same
    // millisecond as the reset. The audit rows have no event order, so they are
    // bounded conservatively by the barrier instant, and a row exactly on the
    // boundary is flagged as uncertain rather than silently trusted or dropped.
    const fromAudit = (
      items: readonly PriorVerdictItem[],
    ): readonly PriorVerdictItem[] =>
      barrier === null ? items : items.filter((item) => item.ts >= barrier);
    // The session scan applies the barrier itself when the reset record is in the
    // log. When the reset only exists in this runtime — the durable writer was
    // unavailable — nothing in the log bounds the items, so the same instant is
    // applied here. A verdict stamped exactly at the barrier is kept: the session
    // knows its own event order, and dropping a real post-reset verdict is worse
    // than showing one from the same millisecond.
    const fromSession = (
      items: readonly PriorVerdictItem[],
    ): readonly PriorVerdictItem[] =>
      barrier === null || this.sessionKnowsBarrier(sessionId, session)
        ? items
        : items.filter((item) => item.ts >= barrier);
    const onBoundary =
      barrier === null
        ? 0
        : [...audit.items, ...(audit.excluded ?? [])].filter(
            (item) => item.ts === barrier,
          ).length;
    if (onBoundary > 0) this.noteBoundaryAmbiguity(sessionId, onBoundary);
    // Each source's window query filters allowed results out. That is right for
    // selection and wrong for consistency: an `allow` on one side facing a `deny`
    // on the other is exactly the disagreement the design forbids resolving by
    // choosing one. The selected ids are re-read on both sides, bounded by the
    // window, so the merger sees both readings.
    const contradictions = this.crossSourceContradictions(sessionId, [
      ...fromSession(session.items),
      ...fromAudit(audit.items),
    ]);
    const { selected, truncated } = selectWindow(
      [
        ...fromSession(session.items),
        ...fromAudit(audit.items),
        ...fromSession(session.excluded ?? []),
        ...fromAudit(audit.excluded ?? []),
        ...contradictions,
      ],
      limit,
    );
    // A newer live entry may have arrived while the sources were read. Merging
    // now, rather than assigning the recovered result, keeps that entry.
    const merged = selectWindow(
      [...(runtime.priorVerdicts.get(sessionId) ?? []), ...selected],
      limit,
    );
    runtime.priorVerdicts.set(sessionId, merged.selected);
    runtime.historyRecovered.set(sessionId, Date.now());
    const status = this.recoveryStatus(
      sessionId,
      session,
      audit,
      merged.selected,
      {
        windowTruncated:
          truncated || merged.truncated || anyOverflow(session, audit),
      },
    );
    runtime.historyStatus.set(
      sessionId,
      barrier === null ? status : { ...status, reset: true },
    );
    return merged.selected;
  }

  /**
   * Decide which history facts this recovery actually supports.
   *
   * Coverage and the capacity cut are computed separately so both can be true at
   * once, and neither is inferred from a row count alone.
   */
  private recoveryStatus(
    sessionId: string,
    session: SourceRead,
    audit: SourceRead,
    selected: readonly PriorVerdictItem[],
    options: { readonly windowTruncated: boolean },
  ): HistoryStatus {
    const sources = {
      memory: ANSWERED,
      session: sourceState(session),
      audit: sourceState(audit),
    };
    const reasons = this.coverageReasons(sessionId, session, audit, selected);
    const windowTruncated = options.windowTruncated;
    if (selected.length === 0) {
      // Neither durable source answered: whether verdicts ever existed is
      // unknown, and an empty window must not be reported as a clean session.
      const durableUnavailable =
        session.unavailable !== null && audit.unavailable !== null;
      return {
        coverage: durableUnavailable
          ? 'unknown'
          : reasons.length > 0
            ? 'partial'
            : 'known-empty',
        windowTruncated,
        reason: reasons.length > 0 ? reasons.join('; ') : null,
        sources,
        reset: false,
      };
    }
    return reasons.length > 0
      ? {
          coverage: 'partial',
          windowTruncated,
          reason: reasons.join('; '),
          sources,
          reset: false,
        }
      : {
          coverage: 'complete',
          windowTruncated,
          reason: null,
          sources,
          reset: false,
        };
  }

  /**
   * Everything this read can say is missing or uncertain.
   *
   * An empty list is the only evidence that allows a completeness claim. Each
   * entry is a concrete fact about this read — an unavailable source, an
   * uninterpretable record, a disagreement, or an empty result that cannot be
   * distinguished from a cleaned history.
   */
  private coverageReasons(
    sessionId: string,
    session: SourceRead,
    audit: SourceRead,
    selected: readonly PriorVerdictItem[],
  ): string[] {
    const invalid = (session.invalid ?? 0) + (audit.invalid ?? 0);
    const reasons: string[] = [];
    if (session.unavailable !== null) {
      reasons.push(
        `the session record source could not be read (${session.unavailable})`,
      );
    }
    if (audit.unavailable !== null) {
      reasons.push(`the audit source could not be read (${audit.unavailable})`);
    }
    if (invalid > 0) {
      reasons.push(
        `${String(invalid)} saved decision record(s) could not be interpreted`,
      );
    }
    // The session-scoped facts — a failed record write, an unplaceable reset
    // boundary, cross-source disagreement and truncated conflict evidence — are
    // shared with the in-memory path, so both report the same completeness for the
    // same window.
    reasons.push(...this.windowReasons(sessionId, selected));
    // A session whose history was explicitly reset is a different case from one
    // whose history is merely unknown: the withdrawn verdicts are absent on
    // purpose, and the reset record itself proves nothing was lost. Its post-reset
    // interval is a real, empty interval, so it may report an empty history.
    const resetInterval =
      this.host.runtime.historyReset.has(sessionId) &&
      this.resetOnlyHistory(sessionId);
    if (
      selected.length === 0 &&
      reasons.length === 0 &&
      !resetInterval &&
      !this.knownEmptyIsProvable(sessionId)
    ) {
      // Both sources answered with nothing, but this session has events, so the
      // absence is not evidence that no verdict ever existed.
      reasons.push(
        'no prior verdict is present in either saved source, and nothing in them proves the session never had one',
      );
    }
    return reasons;
  }
}
