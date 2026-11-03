/**
 * One bounded read of a session's event log, shared by every material reader.
 *
 * Two host facts shape this module:
 *
 *   - A subagent's session starts from an inherited seed, so `snapshotEvents()`
 *     returns the parent chain's events too. Those events belong to another
 *     session's turn numbering and to another session's tool window, so they are
 *     split out (`own`) instead of being read as this session's material.
 *   - Reading can fail transiently. One retry is the whole supplementary read
 *     this plugin is willing to do; a source that still fails is a reported gap,
 *     never an empty result.
 *
 * The read is done once per snapshot so every segment describes the same log.
 * Turn attribution is computed here as well, because the tool window and the
 * evidence stream must agree on which turn an event was written in.
 */

import type { SessionEventLike, SessionLike } from './types.js';

/** Initial read plus one supplementary read; a third would be a retry loop. */
const LOG_READ_ATTEMPTS = 2;
/** Internal read protection, independent of prompt item settings. */
export const SOURCE_EVENT_LIMIT = 16_384;

/** How an event's turn was established. */
export interface SessionLog {
  /** Internal projection provenance; native observation identities remain in coverage. */
  readonly redundantToolResults?: ReadonlySet<number>;
  readonly coverage?: {
    readonly cutoff?: { readonly eventId: string; readonly seq: number } | null;
    readonly protectedOriginalMissing?: string;
    readonly compacted?: boolean;
    readonly stopped: boolean;
    readonly reason: string | null;
    readonly fromSeq: number | null;
    readonly access: 'range' | 'snapshot';
  };
  readonly events: readonly SessionEventLike[];
  /** Events this session wrote itself; an inherited seed is excluded. */
  readonly own: readonly SessionEventLike[];
  /** How many leading events were inherited from the parent chain. */
  readonly inherited: number;
  /** Enclosing host turn per `own` index; `null` when the log did not say. */
  readonly turnOf: readonly (number | null)[];
  readonly readable: boolean;
  /** Why the log could not be read, after the bounded retry. */
  readonly error: string | null;
  readonly attempts: number;
}

interface CapturedRange {
  readonly events: readonly SessionEventLike[];
  readonly own: readonly SessionEventLike[];
  readonly coverage: NonNullable<SessionLog['coverage']>;
}

function validOffset(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function captureRange(session: SessionLike): CapturedRange {
  const end = session.seq;
  const inherited = session.inheritedEventCount;
  if (validOffset(end) && validOffset(inherited) && inherited <= end) {
    const from = Math.max(inherited, end - SOURCE_EVENT_LIMIT);
    const observed = session.snapshotEvents?.(from, end) ?? [];
    const events = observed.filter(
      (event) => event.seq >= from && event.seq < end,
    );
    return {
      events,
      own: events,
      coverage: {
        stopped: from > inherited,
        reason:
          from > inherited
            ? 'source event read protection stopped before older events'
            : null,
        fromSeq: from,
        access: 'range',
      },
    };
  }
  return captureSnapshot(session);
}

function captureSnapshot(session: SessionLike): CapturedRange {
  const events = session.snapshotEvents?.() ?? [];
  const boundary = inheritedBoundary(session, events);
  const own = boundary.own;
  const uncertain = !boundary.known;
  return {
    events: uncertain ? [] : own.slice(-SOURCE_EVENT_LIMIT),
    own: uncertain ? [] : own.slice(-SOURCE_EVENT_LIMIT),
    coverage: {
      stopped: uncertain || own.length > SOURCE_EVENT_LIMIT,
      reason: uncertain
        ? 'the host did not identify the inherited seed boundary'
        : own.length > SOURCE_EVENT_LIMIT
          ? 'source event read protection stopped before older events'
          : null,
      fromSeq: uncertain
        ? null
        : (own.slice(-SOURCE_EVENT_LIMIT)[0]?.seq ?? null),
      access: 'snapshot',
    },
  };
}

/** An unreadable log: nothing was observed, and that is not "empty". */
export function unreadableLog(error: string, attempts: number): SessionLog {
  return {
    events: [],
    own: [],
    inherited: 0,
    turnOf: [],
    readable: false,
    error,
    attempts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural check for a value the host handed back as an event list. */
function isEventLike(value: unknown): value is SessionEventLike {
  return (
    isRecord(value) &&
    typeof value['seq'] === 'number' &&
    Number.isSafeInteger(value['seq']) &&
    value['seq'] >= 0 &&
    typeof value['type'] === 'string'
  );
}

function eventTurn(event: SessionEventLike): number | null {
  if (!isRecord(event.data)) return null;
  const turn = event.data['turn'];
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : null;
}

/**
 * The parent-chain seed length, when the host reports it.
 *
 * Both host surfaces are structural: `ownEvents()` returns the session's own
 * events, and `inheritedEventCount` is the offset where they start. Neither is
 * required — a plain session object simply has no inherited prefix.
 */
function ownSnapshot(
  session: SessionLike,
  events: readonly SessionEventLike[],
): readonly SessionEventLike[] | null {
  if (typeof session.ownEvents !== 'function') return null;
  try {
    const own: unknown = session.ownEvents();
    if (
      !Array.isArray(own) ||
      own.length > events.length ||
      !own.every(isEventLike)
    )
      return null;
    const observed = new Set(events.map((event) => event.seq));
    if (own.some((event: SessionEventLike) => !observed.has(event.seq)))
      return null;
    const ids = new Set(own.map((event: SessionEventLike) => event.seq));
    return events.filter((event) => ids.has(event.seq));
  } catch {
    return null;
  }
}

function inheritedBoundary(
  session: SessionLike,
  events: readonly SessionEventLike[],
): { readonly own: readonly SessionEventLike[]; readonly known: boolean } {
  const own = ownSnapshot(session, events);
  if (own !== null) return { own, known: true };
  const offset = session.inheritedEventCount;
  if (validOffset(offset) && offset <= events.length)
    return { own: events.slice(offset), known: true };
  const mainWithoutBoundary =
    offset === undefined &&
    typeof session.ownEvents !== 'function' &&
    session.header?.parentSession === undefined &&
    session.header?.origin !== 'subagent';
  return { own: mainWithoutBoundary ? events : [], known: mainWithoutBoundary };
}

/**
 * Attribute each own event to its host turn.
 *
 * A turn opens at `turn/start` and closes at `turn/end`; an event that carries
 * its own `turn` field is attributed to that turn regardless of the bracket,
 * because the host stamps the turn on everything it writes inside a step. A
 * `user/message` between turns is attributed to the turn it starts, which is the
 * same turn `turn/start` opens; nothing else advances the counter, so a resumed
 * session, a retry and a timed answer never look like a new turn.
 */
export function turnMarks(
  own: readonly SessionEventLike[],
): readonly (number | null)[] {
  const marks: (number | null)[] = [];
  let open: number | null = null;
  own.forEach((event, index) => {
    if (event.type === 'turn/start') {
      const declared = eventTurn(event);
      open = declared;
      marks.push(declared);
      return;
    }
    if (event.type === 'turn/end') {
      const declared = eventTurn(event);
      marks.push(declared);
      open = null;
      return;
    }
    const declared = eventTurn(event);
    if (declared !== null) {
      marks.push(declared);
      return;
    }
    if (event.type === 'user/message' && open === null) {
      // A prompt opens the turn that the following `turn/start` announces.
      const next = own[index + 1];
      const opening =
        next !== undefined && next.type === 'turn/start'
          ? eventTurn(next)
          : null;
      marks.push(opening);
      return;
    }
    marks.push(open);
  });
  return marks;
}

/**
 * Read the log once, with one supplementary attempt.
 *
 * `label` names the session in a failure message, so a parent failure reads as
 * the parent's and cannot be mistaken for this session's. `attempts` is recorded
 * so a report can say the source was asked twice before being called failed; an
 * unreadable source never becomes an empty log.
 */
export function readSessionLog(
  session: SessionLike,
  label = 'this session',
): SessionLog {
  if (typeof session.snapshotEvents !== 'function') {
    return unreadableLog(`${label} exposes no event log`, 0);
  }
  for (let attempt = 1; attempt <= LOG_READ_ATTEMPTS; attempt += 1) {
    try {
      const { events, own, coverage } = captureRange(session);
      return {
        events,
        own,
        inherited: events.length - own.length,
        turnOf: turnMarks(own),
        readable: true,
        error: null,
        attempts: attempt,
        coverage,
      };
    } catch (error) {
      if (attempt === LOG_READ_ATTEMPTS) {
        return unreadableLog(
          error instanceof Error ? error.message : String(error),
          attempt,
        );
      }
    }
  }
  return unreadableLog(`${label}'s event log could not be read`, 0);
}
