/** Internal source processing protection, independent of prompt token budgets. */
import type {
  ReviewEvent,
  ReviewEventSource,
  ReviewEventSources,
} from '../types.js';
import { SOURCE_EVENT_LIMIT } from './log.js';
import { eventRecord } from './event-content.js';

export const SOURCE_BYTE_LIMIT = 16 * 1024 * 1024;

export function sourceBytes(
  value: unknown,
  remaining = SOURCE_BYTE_LIMIT,
  depth = 0,
): number {
  if (remaining < 0 || depth > 64) return SOURCE_BYTE_LIMIT + 1;
  if (typeof value === 'string')
    return value.length > remaining ? remaining + 1 : Buffer.byteLength(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += sourceBytes(item, remaining - total, depth + 1);
      if (total > remaining) break;
    }
    return total;
  }
  if (eventRecord(value))
    return sourceBytes(Object.values(value), remaining, depth + 1);
  return 8;
}

function reserveHuman(
  source: ReviewEventSource,
  observed: readonly ReviewEvent[],
  latest: ReviewEvent | undefined,
) {
  const question =
    latest?.kind === 'human' && latest.binding !== undefined
      ? observed.findLast(
          (event) =>
            event.kind === 'question' &&
            event.askId === latest.binding?.askId &&
            event.seq < latest.seq,
        )
      : undefined;
  const protectedEvents = [latest, question].filter(
    (event): event is ReviewEvent => event !== undefined,
  );
  const events: ReviewEvent[] = [];
  let total = 0;
  let missing = source.status.protectedOriginalMissing;
  for (const event of protectedEvents) {
    const size = sourceBytes(event, SOURCE_BYTE_LIMIT - total);
    if (total + size > SOURCE_BYTE_LIMIT) {
      missing =
        'latest human original or its bound question exceeds source byte processing protection';
      continue;
    }
    total += size;
    events.push(event);
  }
  return {
    events,
    total,
    missing,
    reserved: new Set(protectedEvents.map((event) => event.eventId)),
  };
}

function bound(source: ReviewEventSource): ReviewEventSource {
  if (source.status.status === 'unavailable') return { ...source, events: [] };
  const eligible = source.events
    .filter(
      (event) =>
        event.sessionId === source.status.sessionId &&
        (source.status.cutoff === null ||
          event.seq <= source.status.cutoff.seq),
    )
    .sort((a, b) => a.seq - b.seq);
  const observed = eligible.slice(-SOURCE_EVENT_LIMIT);
  const latest = observed.findLast((event) => event.kind === 'human');
  const reservedHuman = reserveHuman(source, observed, latest);
  const { events, missing, reserved } = reservedHuman;
  let total = reservedHuman.total;
  let stopped = eligible.length > observed.length || missing !== undefined;
  for (let at = observed.length - 1; at >= 0; at -= 1) {
    const event = observed[at];
    if (event === undefined || reserved.has(event.eventId)) continue;
    total += sourceBytes(event, SOURCE_BYTE_LIMIT - total);
    if (total > SOURCE_BYTE_LIMIT) {
      stopped = true;
      break;
    }
    events.push(event);
  }
  return {
    events,
    status: {
      ...source.status,
      ...(stopped
        ? {
            status: 'stopped' as const,
            reason:
              source.status.reason ??
              'source processing protection stopped before older events',
          }
        : {}),
      fromSeq: observed[0]?.seq ?? source.status.fromSeq,
      ...(missing === undefined ? {} : { protectedOriginalMissing: missing }),
    },
  };
}

/** Declared workflow sources cross the same finite processing boundary as logs. */
export function boundEventSources(
  sources: ReviewEventSources,
): ReviewEventSources {
  return {
    local: bound(sources.local),
    parent: sources.parent === null ? null : bound(sources.parent),
  };
}
