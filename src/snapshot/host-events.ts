/** Thin DSH log adapter. No clocks, text similarity or inferred authorization. */
import type {
  ReviewEvent,
  ReviewEventIdentity,
  ReviewEventSource,
  ReviewSourceStatus,
} from '../types.js';
import type { SessionLog } from './log.js';
import type { SessionEventLike } from './types.js';
import {
  eventJson,
  eventRecord,
  eventText,
  resultBody,
} from './event-content.js';

import { SOURCE_BYTE_LIMIT, sourceBytes as bytes } from './source-guard.js';
import { resultReference } from './tool-result-reference.js';
import { referenceEvent } from './tool-results.js';

function dataOf(event: SessionEventLike): Record<string, unknown> {
  return eventRecord(event.data) ? event.data : {};
}

function messageOf(event: SessionEventLike): Record<string, unknown> {
  const data = dataOf(event);
  return eventRecord(data['message']) ? data['message'] : data;
}

function callOf(event: SessionEventLike): string | null {
  const data = dataOf(event);
  if (
    (event.type === 'tool/ptc-dispatch-start' ||
      event.type === 'tool/ptc-dispatch') &&
    typeof data['subCallId'] === 'string'
  )
    return data['subCallId'];
  if (typeof data['callId'] === 'string') return data['callId'];
  const message = messageOf(event);
  const source = message['source'];
  if (eventRecord(source) && typeof source['callId'] === 'string')
    return source['callId'];
  return typeof message['toolCallId'] === 'string'
    ? message['toolCallId']
    : null;
}

function identity(
  event: SessionEventLike,
  sessionId: string,
  turn: number | null,
): ReviewEventIdentity {
  const message = messageOf(event);
  const turnId = dataOf(event)['turnId'];
  return {
    eventId: event.eventId ?? JSON.stringify([sessionId, event.seq]),
    sessionId,
    seq: event.seq,
    turnId:
      typeof turnId === 'string' ? turnId : turn === null ? null : String(turn),
    ...(typeof event.time === 'number' ? { time: event.time } : {}),
    ...(typeof message['id'] === 'string' ? { messageId: message['id'] } : {}),
  };
}

function questionsOf(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((item: unknown) =>
      eventRecord(item) && typeof item['question'] === 'string'
        ? [
            Object.keys(item).some((key) => key !== 'id' && key !== 'question')
              ? JSON.stringify(item)
              : value.length > 1 && typeof item['id'] === 'string'
                ? `[${item['id']}] ${item['question']}`
                : item['question'],
          ]
        : [],
    )
    .join('\n');
}

function itemIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) =>
        eventRecord(item) && typeof item['id'] === 'string' ? [item['id']] : [],
      )
    : [];
}

function questionOf(
  event: SessionEventLike,
  base: ReviewEventIdentity,
): ReviewEvent | null {
  const data = dataOf(event);
  if (event.type !== 'tool/call' || data['name'] !== 'ask_user_question')
    return null;
  const args = eventJson(data['arguments']);
  const callId = callOf(event);
  if (callId === null || !eventRecord(args)) return null;
  const text = questionsOf(args['questions']);
  return text.length === 0
    ? null
    : {
        ...base,
        kind: 'question',
        askId: callId,
        callId,
        text,
        questionIds: itemIds(args['questions']),
      };
}

function answerText(batch: Record<string, unknown>): string {
  const answers = batch['answers'];
  if (!Array.isArray(answers)) return '';
  return answers
    .flatMap((answer: unknown) => {
      if (!eventRecord(answer)) return [];
      const selected = answer['selected'];
      const custom = answer['custom'];
      const labels = Array.isArray(selected)
        ? selected.filter((v: unknown): v is string => typeof v === 'string')
        : [];
      const text = [
        ...labels,
        ...(typeof custom === 'string' ? [custom] : []),
      ].join(', ');
      return text.trim().length === 0
        ? []
        : [
            answers.length > 1 && typeof answer['id'] === 'string'
              ? `[${answer['id']}] ${text}`
              : text,
          ];
    })
    .join('\n');
}

function humanChannel(
  event: SessionEventLike,
  asks: ReadonlyMap<string, ReviewEvent>,
): 'original' | 'timed' | 'foreground' | null {
  const message = messageOf(event);
  const source = message['source'];
  if (!eventRecord(source)) return null;
  if (event.type === 'user/message') {
    if (source['kind'] === 'user') return 'original';
    return source['kind'] === 'user-question-reply' ? 'timed' : null;
  }
  const callId = callOf(event);
  const asked = callId === null ? undefined : asks.get(callId);
  return event.type === 'tool/result' &&
    source['kind'] === 'tool' &&
    message['isError'] !== true &&
    asked !== undefined &&
    asked.seq < event.seq
    ? 'foreground'
    : null;
}

function humanBinding(
  event: SessionEventLike,
  batch: unknown,
  original: boolean,
) {
  const source = messageOf(event)['source'];
  const callId = callOf(event);
  const replyId = eventRecord(source)
    ? (source['replyToAskId'] ?? dataOf(event)['replyToAskId'])
    : undefined;
  const askId = original
    ? typeof replyId === 'string'
      ? replyId
      : null
    : callId;
  if (askId === null) return undefined;
  const question =
    !original && eventRecord(batch) ? questionsOf(batch['questions']) : '';
  const inconsistent =
    (eventRecord(batch) &&
      typeof batch['callId'] === 'string' &&
      batch['callId'] !== callId) ||
    inlineMismatch(batch);
  return {
    askId,
    ...answerFields(batch, original),
    ...(inconsistent || question.length === 0 ? {} : { question }),
    status: inconsistent ? ('unavailable' as const) : ('bound' as const),
  };
}

function answerFields(
  batch: unknown,
  original: boolean,
): { readonly answerIds?: readonly string[] } {
  return !original && eventRecord(batch)
    ? { answerIds: itemIds(batch['answers']) }
    : {};
}

function inlineMismatch(batch: unknown): boolean {
  if (!eventRecord(batch) || !Array.isArray(batch['questions'])) return false;
  const questions = itemIds(batch['questions']);
  return (
    questions.length > 0 &&
    itemIds(batch['answers']).some((id) => !questions.includes(id))
  );
}

function humanOf(
  event: SessionEventLike,
  base: ReviewEventIdentity,
  parent: boolean,
  asks: ReadonlyMap<string, ReviewEvent>,
): ReviewEvent | null {
  const channel = humanChannel(event, asks);
  if (channel === null) return null;
  const raw = eventText(messageOf(event)['content']);
  const batch = eventJson(raw);
  const structured =
    channel !== 'original' &&
    eventRecord(batch) &&
    Array.isArray(batch['answers']);
  const text =
    structured && eventRecord(batch)
      ? answerText(batch)
      : channel === 'foreground'
        ? ''
        : raw;
  if (text.trim().length === 0) return null;
  const binding = humanBinding(event, batch, channel === 'original');
  return {
    ...base,
    kind: 'human',
    source: parent ? 'parent-human' : 'session-human',
    text,
    ...(binding === undefined ? {} : { binding }),
  };
}

function messageEvent(
  event: SessionEventLike,
  base: ReviewEventIdentity,
  parentId: string | undefined,
): ReviewEvent | null {
  const message = messageOf(event);
  const text = eventText(message['content']);
  const source = message['source'];
  if (text.trim() === '') return null;
  if (event.type === 'assistant/message')
    return { ...base, kind: 'assistant', text };
  if (event.type !== 'user/message' || !eventRecord(source)) return null;
  if (source['kind'] === 'compact-checkpoint')
    return { ...base, kind: 'checkpoint', text };
  if (
    source['kind'] === 'agent-message' &&
    typeof parentId === 'string' &&
    source['senderSessionId'] === parentId
  )
    return {
      ...base,
      kind: 'relay',
      source: 'parent-relay',
      senderSessionId: parentId,
      text,
    };
  return null;
}

function ordinaryOf(
  event: SessionEventLike,
  base: ReviewEventIdentity,
  parentId: string | undefined,
): ReviewEvent | null {
  const visible = messageEvent(event, base, parentId);
  if (visible !== null) return visible;
  const reference = resultReference(event, base.sessionId);
  if (reference !== null) return referenceEvent(reference, base);
  const data = dataOf(event);
  const message = messageOf(event);
  const callId = callOf(event);
  if (callId === null) return null;
  if (
    (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') &&
    typeof data['name'] === 'string'
  )
    return {
      ...base,
      kind: 'call',
      callId,
      tool: data['name'],
      arguments: structuredClone(data['arguments'] ?? {}),
      ...(typeof data['cwd'] === 'string' ? { cwd: data['cwd'] } : {}),
    };
  if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch')
    return null;
  const status =
    message['isError'] === true
      ? 'failure'
      : message['isError'] === false
        ? 'success'
        : 'unknown';
  return {
    ...base,
    kind: 'result',
    callId,
    status,
    body: resultBody(message),
    ...(typeof data['exitCode'] === 'number'
      ? { exitCode: data['exitCode'] }
      : {}),
  };
}

/** Freeze the local call cutoff before redaction or any source selection. */
export function beforePending(log: SessionLog, callId: string): SessionLog {
  const at = log.own.findIndex(
    (event) =>
      (event.type === 'tool/call' ||
        event.type === 'tool/ptc-dispatch-start') &&
      callOf(event) === callId,
  );
  if (at < 0) return log;
  const own = log.own.slice(0, at);
  return { ...log, events: own, own, turnOf: log.turnOf.slice(0, at) };
}

interface SourceContext {
  readonly parent: boolean;
  readonly log: SessionLog;
  readonly identities: readonly ReviewEventIdentity[];
  readonly asks: ReadonlyMap<string, ReviewEvent>;
  readonly humans: readonly (ReviewEvent | null)[];
  readonly protectedMissing?: string;
}

function sourceContext(
  log: SessionLog,
  sessionId: string,
  parent: boolean,
): SourceContext {
  const asks = new Map<string, ReviewEvent>();
  const identities = log.own.map((event, at) =>
    identity(event, sessionId, log.turnOf[at] ?? null),
  );
  log.own.forEach((event, at) => {
    if (
      event.type !== 'tool/call' ||
      dataOf(event)['name'] !== 'ask_user_question' ||
      bytes(event.data) > SOURCE_BYTE_LIMIT
    )
      return;
    const base = identities[at];
    if (base === undefined) return;
    const question = questionOf(event, base);
    if (question?.kind === 'question') asks.set(question.askId, question);
  });
  const priority = latestHuman(log, identities, parent, asks);
  return { log, asks, identities, parent, ...priority };
}

function latestHuman(
  log: SessionLog,
  identities: readonly ReviewEventIdentity[],
  parent: boolean,
  asks: ReadonlyMap<string, ReviewEvent>,
) {
  const humans: (ReviewEvent | null)[] = Array.from(
    { length: log.own.length },
    () => null,
  );
  for (let at = log.own.length - 1; at >= 0; at -= 1) {
    const event = log.own[at];
    const base = identities[at];
    if (
      event === undefined ||
      base === undefined ||
      humanChannel(event, asks) === null
    )
      continue;
    if (bytes(event.data) > SOURCE_BYTE_LIMIT)
      return {
        humans,
        protectedMissing:
          'latest human original exceeds source byte processing protection',
      };
    const human = humanOf(event, base, parent, asks);
    if (human !== null) {
      humans[at] = human;
      break;
    }
  }
  return { humans };
}

function reservedHuman(context: SourceContext): {
  readonly events: ReviewEvent[];
  readonly missing?: string;
} {
  const latest = context.humans.findLast((event) => event !== null);
  const missing = context.protectedMissing;
  if (latest === undefined)
    return { events: [], ...(missing === undefined ? {} : { missing }) };
  const question =
    latest.kind === 'human' && latest.binding !== undefined
      ? context.asks.get(latest.binding.askId)
      : undefined;
  return {
    events: [latest, ...(question === undefined ? [] : [question])],
    ...(missing === undefined ? {} : { missing }),
  };
}

function scanEvents(
  context: SourceContext,
  reserved: readonly ReviewEvent[],
  parentId: string | undefined,
) {
  const events: ReviewEvent[] = [...reserved];
  const reservedIds = new Set(events.map((event) => event.eventId));
  let total = bytes(events);
  let stopped = context.log.coverage?.stopped === true;
  for (let at = context.log.own.length - 1; at >= 0; at -= 1) {
    const event = context.log.own[at];
    const base = context.identities[at];
    if (
      event === undefined ||
      base === undefined ||
      reservedIds.has(base.eventId)
    )
      continue;
    total += bytes(event.data, SOURCE_BYTE_LIMIT - total);
    if (total > SOURCE_BYTE_LIMIT) {
      stopped = true;
      break;
    }
    const normalized =
      context.humans[at] ??
      humanOf(event, base, context.parent, context.asks) ??
      questionOf(event, base) ??
      ordinaryOf(event, base, parentId);
    if (normalized !== null) events.push(normalized);
  }
  return { events, stopped };
}

function statusOf(
  log: SessionLog,
  stopped: boolean,
  count: number,
): ReviewSourceStatus['status'] {
  if (!log.readable) return 'unavailable';
  if (stopped) return 'stopped';
  return count === 0 ? 'known-empty' : 'complete';
}

function compacted(log: SessionLog): boolean {
  if (log.coverage?.compacted === true) return true;
  return log.own.some((event) => {
    const source = messageOf(event)['source'];
    return (
      event.type === 'user/message' &&
      eventRecord(source) &&
      source['kind'] === 'compact-checkpoint'
    );
  });
}

function sourceReason(log: SessionLog, stopped: boolean): string | null {
  if (!log.readable) return log.error;
  return stopped
    ? (log.coverage?.reason ??
        'source byte processing protection stopped before older events')
    : null;
}

/** Normalize bounded captured source, locating the latest human before ordinary bodies. */
export function hostEventSource(
  log: SessionLog,
  sessionId: string,
  parentId: string | undefined,
  parent = false,
): ReviewEventSource {
  const context = sourceContext(log, sessionId, parent);
  const reserved = reservedHuman(context);
  const scanned = scanEvents(context, reserved.events, parentId);
  const missing = reserved.missing ?? log.coverage?.protectedOriginalMissing;
  const stopped = scanned.stopped || missing !== undefined;
  const last = context.identities.at(-1);
  return {
    events: scanned.events,
    status: {
      sessionId,
      status: statusOf(log, stopped, scanned.events.length),
      cutoff:
        log.coverage?.cutoff ??
        (last === undefined ? null : { eventId: last.eventId, seq: last.seq }),
      fromSeq: log.coverage?.fromSeq ?? log.own[0]?.seq ?? null,
      reason: sourceReason(log, stopped),
      access: log.coverage?.access ?? 'snapshot',
      compacted: compacted(log),
      ...(missing === undefined ? {} : { protectedOriginalMissing: missing }),
    },
  };
}

/** Bound optional source bodies before copying/redaction; keep native cutoff/turns. */
export function boundSourceLog(
  log: SessionLog,
  sessionId: string,
  parentId: string | undefined,
  parent = false,
): SessionLog {
  const source = hostEventSource(log, sessionId, parentId, parent);
  const kept = new Set(source.events.map((event) => event.seq));
  const own: SessionEventLike[] = [];
  const turnOf: (number | null)[] = [];
  log.own.forEach((event, index) => {
    if (!kept.has(event.seq)) return;
    own.push(event);
    turnOf.push(log.turnOf[index] ?? null);
  });
  return {
    ...log,
    events: own,
    own,
    turnOf,
    coverage: {
      access: log.coverage?.access ?? 'snapshot',
      fromSeq: log.coverage?.fromSeq ?? log.own[0]?.seq ?? null,
      stopped: source.status.status === 'stopped',
      reason: source.status.reason,
      cutoff: source.status.cutoff,
      compacted: source.status.compacted === true,
      ...(source.status.protectedOriginalMissing === undefined
        ? {}
        : { protectedOriginalMissing: source.status.protectedOriginalMissing }),
    },
  };
}
