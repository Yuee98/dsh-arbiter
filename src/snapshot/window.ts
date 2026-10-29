/**
 * The current turn's raw tool history.
 *
 * Only the turn the pending action belongs to is material for the review. An
 * earlier turn's tool calls describe work that already concluded: they are not
 * part of what is about to run, they can be arbitrarily long, and the host has
 * already closed that turn. What crosses a turn boundary is authorization
 * evidence, which lives in `evidence.ts` and is deliberately not filtered.
 *
 * Two facts this module keeps straight:
 *
 *   - A tool call is an attempt; only a host-recorded result is an outcome. A
 *     call with no result never ran, and the entry says so instead of implying
 *     success.
 *   - The pending action is excluded. It has not run, so putting it in history
 *     would let the reviewer read the same call twice — once as fact.
 *
 * The host's turn identity is read from the log, never invented: a resumed or
 * retried session keeps its turn numbers, and when the log names no turn at all
 * the whole readable history is used with that limitation reported as a gap.
 */

import type { ContextToolCall } from '../types.js';
import type { SessionEventLike } from './types.js';
import type { SessionLog } from './log.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventTs(event: SessionEventLike): number {
  return typeof event.time === 'number' ? event.time : event.seq;
}

interface CallRecord {
  /** Index in the own log, so turn attribution is read from the same place. */
  readonly index: number;
  readonly callId: string;
  readonly ts: number;
  readonly tool: string;
  readonly arguments: string;
  /** The host's own status for this call's result, or `null` when unrecorded. */
  readonly ok: boolean | null;
}

function resultOk(event: SessionEventLike): boolean | null {
  if (!isRecord(event.data)) return null;
  const message = event.data['message'];
  if (!isRecord(message)) return null;
  return message['isError'] !== true;
}

function resultCallId(event: SessionEventLike): string | null {
  if (!isRecord(event.data)) return null;
  const message = event.data['message'];
  if (!isRecord(message)) return null;
  const source = message['source'];
  if (isRecord(source) && typeof source['callId'] === 'string') {
    return source['callId'];
  }
  const toolCallId = message['toolCallId'];
  return typeof toolCallId === 'string' ? toolCallId : null;
}

function parseArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

/** Every tool call in the own log, oldest first, with its observed outcome. */
function callsOf(log: SessionLog): readonly CallRecord[] {
  const results = new Map<string, boolean>();
  for (const event of log.own) {
    if (event.type !== 'tool/result') continue;
    const callId = resultCallId(event);
    if (callId === null || results.has(callId)) continue;
    const ok = resultOk(event);
    if (ok !== null) results.set(callId, ok);
  }
  const calls: CallRecord[] = [];
  log.own.forEach((event, index) => {
    if (event.type !== 'tool/call' || !isRecord(event.data)) return;
    const callId = event.data['callId'];
    const name = event.data['name'];
    if (typeof callId !== 'string' || typeof name !== 'string') return;
    calls.push({
      index,
      callId,
      ts: eventTs(event),
      tool: name,
      arguments: parseArguments(event.data['arguments']),
      ok: results.get(callId) ?? null,
    });
  });
  return calls.sort((left, right) => left.ts - right.ts);
}

/** One entry as submitted; the attempt is kept only when a result was seen. */
function entryOf(call: CallRecord, argumentMaxChars: number): ContextToolCall {
  const truncated =
    argumentMaxChars >= 0 && call.arguments.length > argumentMaxChars;
  return {
    ts: call.ts,
    tool: call.tool,
    arguments: truncated
      ? `${call.arguments.slice(0, argumentMaxChars)}…`
      : call.arguments,
    ...(truncated ? { argumentsTruncated: true } : {}),
    ...(call.ok === null ? {} : { result: { ok: call.ok } }),
  };
}

export interface WindowOptions {
  /** The pending call, which has not run and is therefore not history. */
  readonly currentCallId: string;
  /** The turn the host announced and has not closed, when it announced one. */
  readonly announcedTurn: number | null;
  readonly maxItems: number;
  readonly argumentMaxChars: number;
}

/** Which turn the pending action belongs to, and how that was established. */
export interface TurnIdentity {
  readonly turn: number | null;
  /** Why no turn could be attributed, or `null` when one was. */
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

export interface ToolWindow {
  /** The current turn's calls, oldest first, with the pending call excluded. */
  readonly calls: readonly ContextToolCall[];
  /** Calls in an earlier turn, which this window drops on purpose. */
  readonly earlierTurnCalls: number;
  /** Calls the capacity window dropped; the loss is truncation, not a gap. */
  readonly dropped: number;
  /**
   * Calls the log actually contains, excluding the pending one.
   *
   * An attribution gap is only a loss when something had to be attributed: a
   * session with no tool history has nothing to limit, so reporting the gap
   * would spend input budget describing a limitation that changed nothing.
   */
  readonly logCallCount: number;
  /** Whether the window lost any of this turn's calls to capacity. */
  readonly truncated: boolean;
  readonly turn: number | null;
}

/**
 * Select the current turn's tool calls, oldest first.
 *
 * The order is the order they were written: this is "the action follows these
 * steps", never a newest-first summary. Capacity applies to the window, and when
 * it does the oldest calls are the ones dropped, because the step next to the
 * pending action is the one that explains it.
 */
export function toolWindow(
  log: SessionLog,
  options: WindowOptions,
): ToolWindow {
  const identity = currentTurnOf(
    log,
    options.currentCallId,
    options.announcedTurn,
  );
  const all = callsOf(log).filter(
    (call) => call.callId !== options.currentCallId,
  );
  if (identity.turn === null) {
    // Attribution failed, so no call can be shown as this turn's history. A
    // finished turn's calls presented as current material would state a fact the
    // log cannot support, and the gap already reports that the limitation exists.
    // An *open* bracket still lets a call written inside it count: that placement
    // is recorded evidence even though the turn number is not.
    const inside =
      openBracket(log) < 0
        ? []
        : all.filter((call) => call.index > openBracket(log));
    return {
      calls: inside.map((call) => entryOf(call, options.argumentMaxChars)),
      earlierTurnCalls: all.length - inside.length,
      dropped: 0,
      truncated: false,
      logCallCount: all.length,
      turn: null,
    };
  }
  // The current turn's own bracket, so an unattributed call is placed by where it
  // was written rather than by assuming it belongs. A call between this turn's
  // `turn/start` and its `turn/end` is part of the turn; one written before the
  // open bracket is an older turn's call however its event was labelled.
  const openAt = log.own.findLastIndex((event) => event.type === 'turn/start');
  const current: CallRecord[] = [];
  let earlierTurnCalls = 0;
  for (const call of all) {
    const mark = log.turnOf[call.index] ?? null;
    if (mark === null) {
      // An unattributed call inside this turn's bracket still belongs to it;
      // dropping it would hide a step the pending action follows. Outside the
      // bracket it is not this turn's material, so it counts as an earlier call.
      if (call.index > openAt) current.push(call);
      else earlierTurnCalls += 1;
      continue;
    }
    if (mark === identity.turn) current.push(call);
    else earlierTurnCalls += 1;
  }
  const limit = Math.max(0, options.maxItems);
  const selected = limit === 0 ? [] : current.slice(-limit);
  return {
    calls: selected.map((call) => entryOf(call, options.argumentMaxChars)),
    earlierTurnCalls,
    dropped: current.length - selected.length,
    truncated: current.length > selected.length,
    turn: identity.turn,
    logCallCount: all.length,
  };
}
