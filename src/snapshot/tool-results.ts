/** Receipt-bound bodies enrich only observations in the captured native prefix. */
import type {
  ToolResultRead,
  ToolResultReceipt,
} from '../audit/tool-result-types.js';
import type {
  ReviewEvent,
  ReviewEventIdentity,
  ReviewEventSource,
  ReviewResultBody,
} from '../types.js';
import type { SessionLog } from './log.js';
import { eventRecord } from './event-content.js';
import {
  resultReference,
  type ResultReference,
} from './tool-result-reference.js';
import { SOURCE_BYTE_LIMIT, sourceBytes } from './source-guard.js';

export interface ToolResultSourceReader {
  /** Bound to the same workflow redactor used for the final snapshot. */
  discover(log: SessionLog): void;
  read(expected: ToolResultReceipt): ToolResultRead;
}
export function referenceEvent(
  reference: ResultReference,
  base: ReviewEventIdentity,
): ReviewEvent | null {
  if (reference.tool === 'ask_user_question') return null;
  return {
    ...base,
    kind: 'result',
    callId: reference.callId,
    status: reference.status,
    body:
      reference.contentState === 'empty' && reference.save === 'saved'
        ? { state: 'empty' }
        : { state: 'unavailable', reason: 'not-provided' },
    collection: { save: reference.save, content: reference.contentState },
  };
}
function nativeCall(event: SessionLog['own'][number]): string | null {
  if (!eventRecord(event.data)) return null;
  if (event.type === 'tool/ptc-dispatch')
    return typeof event.data['subCallId'] === 'string'
      ? event.data['subCallId']
      : null;
  if (event.type !== 'tool/result') return null;
  const message = event.data['message'];
  const source = eventRecord(message) ? message['source'] : undefined;
  return eventRecord(source) &&
    source['kind'] === 'tool' &&
    typeof source['callId'] === 'string'
    ? source['callId']
    : null;
}
/** Learn raw values before replacing redundant native bodies, never clone them. */
export function prepareToolResultLog(
  log: SessionLog,
  sessionId: string,
  reader: ToolResultSourceReader,
): SessionLog {
  const asks = new Set(
    log.own.flatMap((event) => {
      if (
        !eventRecord(event.data) ||
        event.data['name'] !== 'ask_user_question'
      )
        return [];
      const id =
        event.type === 'tool/ptc-dispatch-start'
          ? event.data['subCallId']
          : event.type === 'tool/call'
            ? event.data['callId']
            : undefined;
      return typeof id === 'string' ? [id] : [];
    }),
  );
  const refs = new Map<string, number>();
  for (const event of log.own) {
    const ref = resultReference(event, sessionId);
    if (
      ref !== null &&
      ref.tool !== 'ask_user_question' &&
      !asks.has(ref.callId) &&
      !refs.has(ref.callId)
    )
      refs.set(ref.callId, event.seq);
  }
  const removed = log.own.filter((event) => {
    const callId = nativeCall(event);
    const referenceSeq = callId === null ? undefined : refs.get(callId);
    return referenceSeq !== undefined && referenceSeq < event.seq;
  });
  reader.discover({ ...log, events: removed, own: removed, turnOf: [] });
  const seqs = new Set(removed.map((event) => event.seq));
  const own = log.own.map((event) => {
    if (!seqs.has(event.seq) || !eventRecord(event.data)) return event;
    const data = event.data;
    const message = data['message'];
    return eventRecord(message)
      ? {
          ...event,
          data: {
            ...(typeof data['exitCode'] === 'number'
              ? { exitCode: data['exitCode'] }
              : {}),
            message: {
              id: message['id'],
              source: message['source'],
              isError: message['isError'],
            },
          },
        }
      : {
          ...event,
          data: {
            subCallId: data['subCallId'],
            rootCallId: data['rootCallId'],
            parentCallId: data['parentCallId'],
            isError: data['isError'],
          },
        };
  });
  return { ...log, events: own, own };
}
function bodyOf(read: ToolResultRead): ReviewResultBody {
  const metadata = read.metadata;
  if (read.state !== 'found' || metadata === null)
    return {
      state: 'unavailable',
      reason:
        read.state === 'cleared' || read.state === 'missing-file'
          ? 'lost'
          : 'unreadable',
    };
  if (metadata.contentState === 'empty') return { state: 'empty' };
  if (
    metadata.contentState === 'no-result' ||
    metadata.contentState === 'unavailable'
  )
    return { state: 'unavailable', reason: 'not-provided' };
  if (metadata.contentState === 'unsupported')
    return {
      state: 'omitted',
      media: metadata.parts.flatMap((part) =>
        part.kind === 'media'
          ? [
              {
                type: part.mediaType ?? 'media',
                ...(part.reference === null ? {} : { ref: part.reference }),
                note: 'media body not provided',
              },
            ]
          : [],
      ),
    };
  return {
    state: 'present',
    content: {
      processingVersion: metadata.processingVersion,
      fragments: read.fragments,
      ranges: metadata.ranges,
      parts: metadata.parts,
      sourceBytes: metadata.sourceBytes,
      retainedBytes: metadata.retainedBytes,
      sha256: metadata.sha256,
    },
    ...(!metadata.upstreamTruncated && metadata.localTruncation === null
      ? {}
      : {
          truncations: [
            ...(metadata.upstreamTruncated
              ? [
                  {
                    source: 'upstream' as const,
                    note: 'upstream truncation reported',
                  },
                ]
              : []),
            ...(metadata.localTruncation === null
              ? []
              : [
                  {
                    source: 'collection' as const,
                    note: 'separate retained ranges; omitted bytes are not adjacent',
                  },
                ]),
          ],
        }),
  };
}
function sameReceipt(
  expected: ToolResultReceipt,
  read: ToolResultRead,
): boolean {
  return (
    read.receipt?.sessionId === expected.sessionId &&
    read.receipt.callId === expected.callId &&
    read.receipt.resultId === expected.resultId
  );
}
function enrich(
  event: ReviewEvent,
  ref: ResultReference,
  reader: ToolResultSourceReader,
): ReviewEvent {
  if (event.kind !== 'result' || ref.save !== 'saved' || ref.receipt === null)
    return event;
  const read = reader.read(ref.receipt);
  const valid =
    ((read.receipt === null && read.state !== 'found') ||
      sameReceipt(ref.receipt, read)) &&
    (read.state !== 'found' ||
      (read.metadata?.status === ref.status &&
        read.metadata.contentState === ref.contentState));
  return {
    ...event,
    body: valid ? bodyOf(read) : { state: 'unavailable', reason: 'unreadable' },
    collection: {
      save: ref.save,
      content: ref.contentState,
      read: valid ? read.state : 'unavailable',
    },
  };
}
/** Incremental fetch: at most one bounded result beyond the remaining source cap. */
export function enrichToolResults(
  source: ReviewEventSource,
  log: SessionLog,
  reader: ToolResultSourceReader,
): ReviewEventSource {
  const refs = new Map(
    log.own.flatMap((event) => {
      const ref = resultReference(event, source.status.sessionId);
      return ref === null ? [] : [[event.seq, ref] as const];
    }),
  );
  let bytes = sourceBytes(source.events);
  let stopped = false;
  const events: ReviewEvent[] = [];
  for (const event of [...source.events].sort((a, b) => b.seq - a.seq)) {
    const ref = refs.get(event.seq);
    if (ref === undefined || event.kind !== 'result') {
      events.push(event);
      continue;
    }
    if (stopped) continue;
    const next = enrich(event, ref, reader);
    bytes += sourceBytes(next) - sourceBytes(event);
    if (bytes > SOURCE_BYTE_LIMIT) {
      stopped = true;
      continue;
    }
    events.push(next);
  }
  return {
    events,
    status: {
      ...source.status,
      ...(stopped
        ? {
            status: 'stopped' as const,
            reason:
              'tool result source processing protection stopped before older bodies',
          }
        : {}),
    },
  };
}
