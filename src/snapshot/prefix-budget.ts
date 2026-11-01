/** H-only compatibility bridge. T/H/C allocation belongs to the next task. */
import type { ReviewEvent, ReviewPrefix } from '../types.js';

function unitKey(event: ReviewEvent): string {
  if (
    event.kind === 'call' ||
    event.kind === 'result' ||
    event.kind === 'settlement'
  )
    return JSON.stringify(['call', event.callId]);
  return JSON.stringify(['event', event.eventId]);
}

function removableUnits(
  events: readonly ReviewEvent[],
): readonly ReviewEvent[][] {
  const groups = new Map<string, ReviewEvent[]>();
  for (const event of events) {
    const key = unitKey(event);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const requiredQuestions = new Set(
    events.flatMap((event) =>
      event.kind === 'human' &&
      event.binding?.status === 'bound' &&
      event.binding.questionEventId !== undefined
        ? [event.binding.questionEventId]
        : [],
    ),
  );
  return [...groups.values()]
    .filter(
      (group) =>
        !group.some(
          (event) =>
            event.protected === true ||
            (event.kind === 'question' && requiredQuestions.has(event.eventId)),
        ),
    )
    .sort(
      (a, b) =>
        Number(b[0]?.kind === 'checkpoint') -
          Number(a[0]?.kind === 'checkpoint') ||
        (a[0]?.seq ?? 0) - (b[0]?.seq ?? 0),
    );
}

export function trimPrefix(prefix: ReviewPrefix): {
  readonly prefix: ReviewPrefix;
  readonly evidence: boolean;
  readonly checkpoint: boolean;
  readonly tools: boolean;
} | null {
  for (const key of ['local', 'parent'] as const) {
    const source = prefix[key];
    if (source === null) continue;
    const units = removableUnits(source.events);
    if (units.length === 0) continue;
    // Large populations shrink geometrically; no per-item full-prompt render loop.
    // This is a conservative H bridge, not the next task's T/C allocator.
    const batch = source.events.length > 128 ? Math.ceil(units.length / 4) : 1;
    const removed = units.slice(0, batch).flat();
    const ids = new Set(removed.map((event) => event.eventId));
    const sessionId = source.status.sessionId;
    const old = prefix.omissions.find(
      (entry) => entry.sessionId === sessionId && entry.cause === 'budget',
    );
    return {
      prefix: {
        ...prefix,
        [key]: {
          ...source,
          events: source.events.filter((event) => !ids.has(event.eventId)),
        },
        omissions: [
          ...prefix.omissions.filter((entry) => entry !== old),
          {
            sessionId,
            cause: 'budget',
            reason: 'whole event units omitted by the input budget',
            count: (old?.count ?? 0) + removed.length,
          },
        ],
      },
      evidence: removed.some(
        (event) => event.kind === 'human' || event.kind === 'relay',
      ),
      checkpoint: removed.some((event) => event.kind === 'checkpoint'),
      tools: removed.some(
        (event) =>
          event.kind === 'call' ||
          event.kind === 'result' ||
          event.kind === 'assistant',
      ),
    };
  }
  return null;
}
