/** One mechanical candidate selector for host and workflow sources. */
import type {
  ReviewAnswerBinding,
  ContextCheckpoint,
  ContextToolCall,
  EvidenceItem,
} from '../types.js';
import type {
  ReviewEvent,
  ReviewEventSource,
  ReviewEventSources,
  ReviewPrefix,
} from '../types.js';

function ordered(source: ReviewEventSource): ReviewEvent[] {
  if (source.status.status === 'unavailable') return [];
  const seen = new Set<string>();
  return [...source.events]
    .sort((a, b) => a.seq - b.seq)
    .filter((event) => {
      if (
        event.sessionId !== source.status.sessionId ||
        seen.has(event.eventId)
      )
        return false;
      if (source.status.cutoff !== null && event.seq > source.status.cutoff.seq)
        return false;
      seen.add(event.eventId);
      return true;
    })
    .map((event) => ({ ...structuredClone(event), protected: false }));
}

function bindings(events: readonly ReviewEvent[]): ReviewEvent[] {
  const questions = new Map<
    string,
    Extract<ReviewEvent, { kind: 'question' }>
  >();
  return events.map((event) => {
    if (event.kind === 'question') questions.set(event.askId, event);
    if (event.kind !== 'human' || event.binding === undefined) return event;
    const binding = event.binding;
    if (binding.status === 'unavailable') return event;
    const observed = questions.get(binding.askId);
    const question =
      observed !== undefined && observed.seq < event.seq ? observed : undefined;
    const mismatch = bindingMismatch(binding, question);
    if (mismatch)
      return {
        ...event,
        binding: { askId: binding.askId, status: 'unavailable' as const },
      };
    const { question: inlineQuestion, ...rest } = binding;
    return {
      ...event,
      binding: {
        ...rest,
        status:
          question !== undefined || binding.question !== undefined
            ? ('bound' as const)
            : ('unavailable' as const),
        ...(question === undefined
          ? {}
          : { questionEventId: question.eventId }),
        // When the original question is visible, the answer references it once.
        ...(question === undefined && inlineQuestion !== undefined
          ? { question: inlineQuestion }
          : {}),
      },
    };
  });
}

function bindingMismatch(
  binding: ReviewAnswerBinding,
  question: Extract<ReviewEvent, { kind: 'question' }> | undefined,
): boolean {
  const ids = question?.questionIds;
  return (
    ids !== undefined &&
    binding.answerIds !== undefined &&
    binding.answerIds.some((id) => !ids.includes(id))
  );
}

function selected(
  source: ReviewEventSource,
  parent: boolean,
): ReviewEventSource {
  const events = bindings(ordered(source));
  const latest = events.findLast((event) => event.kind === 'human');
  const assistant =
    parent || latest === undefined
      ? undefined
      : events.findLast(
          (event) => event.kind === 'assistant' && event.seq < latest.seq,
        );
  const checkpoint = events.findLast((event) => event.kind === 'checkpoint');
  const boundQuestions = new Set(
    events.flatMap((event) =>
      event.kind === 'human' && event.binding?.questionEventId !== undefined
        ? [event.binding.questionEventId]
        : [],
    ),
  );
  const protectedQuestion =
    latest?.kind === 'human' ? latest.binding?.questionEventId : undefined;
  const calls = new Map(
    events.flatMap((event) =>
      event.kind === 'call' ? [[event.callId, event] as const] : [],
    ),
  );
  return {
    status: structuredClone(source.status),
    events: events
      .filter((event) => {
        if (parent)
          return (
            event.kind === 'human' ||
            (event.kind === 'question' && boundQuestions.has(event.eventId))
          );
        if (event.kind === 'assistant') return event === assistant;
        if (event.kind === 'checkpoint') return event === checkpoint;
        return true;
      })
      .map((event) => {
        const protectedEvent =
          event === latest || event.eventId === protectedQuestion;
        if (event.kind !== 'result')
          return { ...event, protected: protectedEvent };
        const call = calls.get(event.callId);
        return {
          ...event,
          protected: protectedEvent,
          ...(call === undefined || call.seq >= event.seq
            ? { callUnavailable: 'not-observed' as const }
            : {
                call: {
                  eventId: call.eventId,
                  tool: call.tool,
                  ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
                },
              }),
        };
      }),
  };
}

export function buildEventPrefix(
  sources: ReviewEventSources,
  pendingCallId: string,
): ReviewPrefix {
  const localSource = {
    ...sources.local,
    events: sources.local.events.filter(
      (event) =>
        !(
          (event.kind === 'call' ||
            event.kind === 'result' ||
            event.kind === 'settlement' ||
            event.kind === 'question') &&
          event.callId === pendingCallId
        ),
    ),
  };
  const local = selected(localSource, false);
  const parent =
    sources.parent === null ? null : selected(sources.parent, true);
  return {
    local,
    parent,
    omissions: [local, ...(parent === null ? [] : [parent])].flatMap(
      (source) =>
        source.status.status === 'stopped'
          ? [
              {
                sessionId: source.status.sessionId,
                cause: 'read' as const,
                reason: source.status.reason ?? 'source read stopped',
              },
            ]
          : [],
    ),
  };
}

export function prefixProtectedGaps(prefix: ReviewPrefix): readonly {
  readonly source: 'session-human' | 'parent-human';
  readonly reason: string;
  readonly kind: 'unreadable';
}[] {
  return [prefix.local, ...(prefix.parent === null ? [] : [prefix.parent])]
    .flatMap((source) => {
      const kind =
        source === prefix.local
          ? ('session-human' as const)
          : ('parent-human' as const);
      const latest = source.events.findLast((event) => event.kind === 'human');
      if (source.status.protectedOriginalMissing !== undefined)
        return [
          { source: kind, reason: source.status.protectedOriginalMissing },
        ];
      if (latest === undefined && source.status.status === 'stopped')
        return [
          {
            source: kind,
            reason: `${kind}: latest original availability is unknown because source reading stopped`,
          },
        ];
      if (latest?.kind === 'human' && latest.binding?.status === 'unavailable')
        return [
          {
            source: kind,
            reason: `${kind}: the host-bound question for the latest answer is unavailable`,
          },
        ];
      return [];
    })
    .map((drop) => ({ ...drop, kind: 'unreadable' as const }));
}

function questionText(
  event: Extract<ReviewEvent, { kind: 'human' }>,
  events: ReadonlyMap<string, ReviewEvent>,
): string | undefined {
  const bound =
    event.binding?.questionEventId === undefined
      ? undefined
      : events.get(event.binding.questionEventId);
  return (
    event.binding?.question ??
    (bound?.kind === 'question' ? bound.text : undefined)
  );
}

function numericTurn(turnId: string | null): { readonly turn?: number } {
  if (turnId === null) return {};
  const turn = Number(turnId);
  return Number.isInteger(turn) ? { turn } : {};
}

function humanEvidence(
  event: Extract<ReviewEvent, { kind: 'human' }>,
  events: ReadonlyMap<string, ReviewEvent>,
): EvidenceItem {
  const question = questionText(event, events);
  return {
    ts: event.time ?? event.seq,
    source: { kind: event.source, sessionId: event.sessionId },
    role: 'human-instruction',
    evidence: 'explicit',
    sourcePriority: event.source === 'session-human' ? 1 : 2,
    text:
      question !== undefined && event.binding !== undefined
        ? `Question: ${question}\nAnswer: ${event.text}`
        : event.text,
    ...numericTurn(event.turnId),
    ...(question === undefined ? {} : { question }),
    ...(event.binding === undefined ? {} : { askCallId: event.binding.askId }),
  };
}

function evidenceOf(events: readonly ReviewEvent[]): EvidenceItem[] {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  return events
    .flatMap((event) => {
      if (event.kind === 'human') return [humanEvidence(event, byId)];
      if (event.kind !== 'relay') return [];
      return [
        {
          ts: event.time ?? event.seq,
          source: { kind: event.source, sessionId: event.senderSessionId },
          role: 'direct-parent-instruction' as const,
          evidence: 'implied' as const,
          sourcePriority: 5 as const,
          text: event.text,
          ...numericTurn(event.turnId),
        },
      ];
    })
    .reverse();
}

/** Compatibility fields are derived from the selected prefix, never another read. */
export function prefixCompatibility(prefix: ReviewPrefix): {
  readonly evidence: readonly EvidenceItem[];
  readonly context: readonly ContextToolCall[];
  readonly checkpoints: readonly ContextCheckpoint[];
} {
  const results = new Map<string, Extract<ReviewEvent, { kind: 'result' }>>();
  for (const event of prefix.local.events)
    if (event.kind === 'result') results.set(event.callId, event);
  return {
    evidence: [
      ...evidenceOf(prefix.local.events),
      ...evidenceOf(prefix.parent?.events ?? []),
    ],
    context: prefix.local.events.flatMap((event) => {
      if (event.kind !== 'call') return [];
      const result = results.get(event.callId);
      return [
        {
          ts: event.time ?? event.seq,
          tool: event.tool,
          arguments:
            typeof event.arguments === 'string'
              ? event.arguments
              : JSON.stringify(event.arguments),
          ...(result?.kind !== 'result' || result.status === 'unknown'
            ? {}
            : { result: { ok: result.status === 'success' } }),
        },
      ];
    }),
    checkpoints: prefix.local.events.flatMap((event) =>
      event.kind === 'checkpoint'
        ? [{ ts: event.time ?? event.seq, text: event.text }]
        : [],
    ),
  };
}

/** Existing history ablation withholds tool records and summaries, never humans. */
export function prefixWithoutHistory(prefix: ReviewPrefix): ReviewPrefix {
  return {
    ...prefix,
    local: {
      ...prefix.local,
      events: prefix.local.events.filter(
        (event) =>
          event.kind !== 'call' &&
          event.kind !== 'result' &&
          event.kind !== 'checkpoint',
      ),
    },
  };
}
