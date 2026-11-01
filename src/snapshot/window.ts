/** Resolve host turn attribution; candidate selection does not filter by turn. */
import type { SessionLog } from './log.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface TurnIdentity {
  readonly turn: number | null;
  readonly gap: string | null;
}

/**
 * Where the newest still-open `turn/start` sits, or `-1` when none is open.
 *
 * A turn is opened by `turn/start` and closed by `turn/end`, so any `turn/end`
 * after the newest `turn/start` means nothing is open.
 */
function openBracket(log: SessionLog): number {
  for (let cursor = log.own.length - 1; cursor >= 0; cursor -= 1) {
    const event = log.own[cursor];
    if (event === undefined) return -1;
    if (event.type === 'turn/end') return -1;
    if (event.type === 'turn/start') return cursor;
  }
  return -1;
}

/**
 * Whether the log's last turn is still open.
 *
 * A turn is opened by `turn/start` and closed by `turn/end`, so the newest open
 * turn is the one in progress. Walking backward is not enough on its own: the
 * closing event also carries its turn number, so reading the newest non-null
 * mark would return a turn the host has already finished.
 */
function openTurnOf(log: SessionLog): number | null {
  const bracket = openBracket(log);
  return bracket < 0 ? null : (log.turnOf[bracket] ?? null);
}

/**
 * Resolve the pending action's turn.
 *
 * Three sources, in decreasing authority:
 *
 *   1. the pending call's own `tool/call` event, when the host has already
 *      recorded it — its `turn` field is the host's answer, not a deduction;
 *   2. the turn the host announced with `turn/start` and has not closed, which
 *      is what the gate sees before this call's own event exists;
 *   3. the newest turn whose `turn/start` bracket is still open in the log.
 *
 * A closed turn is never a candidate. If the log's newest bracket is closed and
 * no turn was announced, the attribution is unknown, and the snapshot says so
 * instead of presenting a finished turn's calls as current. A locally derived
 * number is never used either: recovery, retry and a timed answer all keep the
 * host's own turn, and a counter of our own would make each look new.
 */
export function currentTurnOf(
  log: SessionLog,
  currentCallId: string,
  announced: number | null,
): TurnIdentity {
  const index = log.own.findIndex(
    (event) =>
      event.type === 'tool/call' &&
      isRecord(event.data) &&
      event.data['callId'] === currentCallId,
  );
  if (index >= 0) {
    const mark = log.turnOf[index] ?? null;
    if (mark !== null) return { turn: mark, gap: null };
  }
  if (announced !== null) return { turn: announced, gap: null };
  const open = openTurnOf(log);
  if (open !== null) return { turn: open, gap: null };
  // Distinguish the two unknown cases, because only one of them is expected: a
  // log with no turn identity at all is a host that never wrote one, while a log
  // whose newest bracket is closed means this call arrived outside a turn. Both
  // leave attribution unknown; neither may borrow a finished turn's calls.
  const namedAny = log.turnOf.some((mark) => mark !== null);
  return {
    turn: null,
    gap: namedAny
      ? 'the newest host turn is already closed, so no open turn could be attributed to this call and its tool history was not limited to one turn'
      : 'the session log named no turn, so the tool history could not be limited to the current turn',
  };
}
