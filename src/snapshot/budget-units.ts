/** Mechanical units preserve identity and display order, independent of protocol. */
import type {
  ReviewEvent,
  ReviewEventSource,
  ReviewSnapshot,
} from '../types.js';
import { jsonFragment, shortenedText } from './budget-text.js';

type Snapshot = ReviewSnapshot;
export interface BudgetUnit {
  readonly id: string;
  readonly priority: number;
  readonly order: number;
  readonly capped: boolean;
  readonly kind:
    | 'human'
    | 'relay'
    | 'tool'
    | 'prior'
    | 'assistant'
    | 'facts'
    | 'hint'
    | 'checkpoint';
  readonly area?: 'local' | 'parent';
  readonly events?: readonly ReviewEvent[];
  readonly evidence?: Snapshot['evidence'][number];
  readonly context?: Snapshot['context'][number];
  readonly checkpoint?: Snapshot['checkpoints'][number];
  readonly prior?: Snapshot['priorVerdicts'][number];
  readonly facts?: NonNullable<Snapshot['facts']>;
  readonly hint?: string;
}

function callIdOf(event: ReviewEvent): string | null {
  if (
    event.kind === 'call' ||
    event.kind === 'result' ||
    event.kind === 'settlement'
  )
    return event.callId;
  return event.kind === 'question' ? (event.callId ?? null) : null;
}

function kindOf(event: ReviewEvent | undefined): BudgetUnit['kind'] {
  if (event === undefined) return 'tool';
  if (
    event.kind === 'call' ||
    event.kind === 'result' ||
    event.kind === 'settlement' ||
    event.kind === 'question'
  )
    return 'tool';
  return event.kind;
}

function priorityOf(
  kind: BudgetUnit['kind'],
  area: 'local' | 'parent',
): number {
  if (kind === 'human') return area === 'local' ? 0 : 1;
  return {
    relay: 2,
    tool: 3,
    prior: 4,
    assistant: 5,
    facts: 6,
    hint: 7,
    checkpoint: 8,
  }[kind];
}

function eventUnits(
  events: readonly ReviewEvent[],
  area: 'local' | 'parent',
): BudgetUnit[] {
  const groups = new Map<string, ReviewEvent[]>();
  const questions = new Map(
    events.filter((e) => e.kind === 'question').map((e) => [e.eventId, e]),
  );
  const bound = new Set(
    events.flatMap((e) =>
      e.kind === 'human' && e.binding?.questionEventId !== undefined
        ? [e.binding.questionEventId]
        : [],
    ),
  );
  for (const event of events) {
    if (
      event.protected === true ||
      (event.kind === 'question' && bound.has(event.eventId))
    )
      continue;
    const callId = callIdOf(event);
    const key = JSON.stringify(
      callId === null ? ['event', event.eventId] : ['call', callId],
    );
    const values = groups.get(key) ?? [];
    values.push(event);
    groups.set(key, values);
  }
  return [...groups.values()].map((values) => {
    const first = values[0];
    if (first === undefined) throw new Error('empty event unit');
    const callId = callIdOf(first);
    const id = callId === null ? `event:${first.eventId}` : `call:${callId}`;
    const kind = kindOf(values[0]);
    const priority = priorityOf(kind, area);
    for (const event of [...values]) {
      if (
        event.kind !== 'human' ||
        event.binding?.questionEventId === undefined
      )
        continue;
      const question = questions.get(event.binding.questionEventId);
      if (question !== undefined) values.push(question);
    }
    return {
      id: `${area}:${id}`,
      priority,
      order: Math.max(...values.map((e) => e.seq)),
      capped: kind === 'tool' || kind === 'assistant' || kind === 'checkpoint',
      kind,
      area,
      events: values,
    };
  });
}

function newestOriginal(
  base: Snapshot,
  kind: 'session-human' | 'parent-human',
  role: 'human-instruction' | 'direct-parent-instruction',
): Snapshot['evidence'][number] | undefined {
  let newest: Snapshot['evidence'][number] | undefined;
  for (const item of base.evidence) {
    if (
      item.source.kind !== kind ||
      item.role !== role ||
      item.evidence !== 'explicit'
    )
      continue;
    if (newest === undefined || item.ts >= newest.ts) newest = item;
  }
  return newest;
}

function legacyUnits(base: Snapshot): BudgetUnit[] {
  const newestLocal = newestOriginal(
    base,
    'session-human',
    'human-instruction',
  );
  const newestParent = newestOriginal(
    base,
    'parent-human',
    'direct-parent-instruction',
  );
  const ordered = base.evidence
    .map((evidence, index) => ({ evidence, index }))
    .sort((a, b) => a.evidence.ts - b.evidence.ts || a.index - b.index);
  return [
    ...ordered.flatMap(({ evidence, index: i }, order): BudgetUnit[] =>
      evidence === newestLocal || evidence === newestParent
        ? []
        : [
            {
              id: `evidence:${String(i)}`,
              priority:
                evidence.source.kind === 'session-human'
                  ? 0
                  : evidence.source.kind === 'parent-human'
                    ? 1
                    : 2,
              order,
              capped: false,
              kind: evidence.source.kind === 'parent-relay' ? 'relay' : 'human',
              evidence,
            },
          ],
    ),
    ...base.context.map((context, i): BudgetUnit => ({
      id: `context:${String(i)}`,
      priority: 3,
      order: i,
      capped: true,
      kind: 'tool',
      context,
    })),
    ...base.checkpoints.map((checkpoint, i): BudgetUnit => ({
      id: `checkpoint:${String(i)}`,
      priority: 8,
      order: i,
      capped: true,
      kind: 'checkpoint',
      checkpoint,
    })),
  ];
}

function factsUnits(facts: Snapshot['facts']): BudgetUnit[] {
  if (facts === null) return [];
  const header = {
    ...facts,
    observed: {
      ...facts.observed,
      writes: [],
      networkCommands: [],
      credentialPaths: [],
      pipelineExec: [],
    },
    unresolvedExpansions: [],
    completeness:
      facts.completeness === 'complete'
        ? ('partial' as const)
        : facts.completeness,
    truncated: true,
  };
  const common = { priority: 6, capped: false, kind: 'facts' as const };
  const units: BudgetUnit[] = [
    {
      ...common,
      id: 'facts:header',
      order: Number.MAX_SAFE_INTEGER,
      facts: header,
    },
  ];
  for (const key of [
    'writes',
    'networkCommands',
    'credentialPaths',
    'pipelineExec',
  ] as const) {
    facts.observed[key].forEach((value, index) =>
      units.push({
        ...common,
        id: `facts:${key}:${String(index)}`,
        order: -index,
        facts: { ...header, observed: { ...header.observed, [key]: [value] } },
      }),
    );
  }
  facts.unresolvedExpansions.forEach((value, index) =>
    units.push({
      ...common,
      id: `facts:expansion:${String(index)}`,
      order: -index,
      facts: { ...header, unresolvedExpansions: [value] },
    }),
  );
  return units;
}

function appendFacts(
  current: Snapshot['facts'],
  incoming: NonNullable<Snapshot['facts']>,
): NonNullable<Snapshot['facts']> {
  if (current === null) return incoming;
  return {
    ...current,
    observed: {
      ...current.observed,
      writes: [...current.observed.writes, ...incoming.observed.writes],
      networkCommands: [
        ...current.observed.networkCommands,
        ...incoming.observed.networkCommands,
      ],
      credentialPaths: [
        ...current.observed.credentialPaths,
        ...incoming.observed.credentialPaths,
      ],
      pipelineExec: [
        ...current.observed.pipelineExec,
        ...incoming.observed.pipelineExec,
      ],
    },
    unresolvedExpansions: [
      ...current.unresolvedExpansions,
      ...incoming.unresolvedExpansions,
    ],
  };
}

export function candidateUnits(base: Snapshot): readonly BudgetUnit[] {
  const events =
    base.prefix === undefined
      ? legacyUnits(base)
      : [
          ...eventUnits(base.prefix.local.events, 'local'),
          ...eventUnits(base.prefix.parent?.events ?? [], 'parent'),
        ];
  const factUnits = factsUnits(base.facts);
  return [
    ...events,
    ...base.priorVerdicts.map((prior, i): BudgetUnit => ({
      id: `prior:${String(i)}`,
      priority: 4,
      order: -i,
      capped: false,
      kind: 'prior',
      prior,
    })),
    ...factUnits,
    ...(base.hint === undefined
      ? []
      : [
          {
            id: 'hint',
            priority: 7,
            order: 0,
            capped: true,
            kind: 'hint' as const,
            hint: base.hint,
          },
        ]),
  ].sort(
    (a, b) =>
      a.priority - b.priority || b.order - a.order || a.id.localeCompare(b.id),
  );
}

/** Retain actual channel labels while shortening each observed text block. */
function resultCopy(value: unknown, scale: number): unknown {
  if (scale >= 1) return value;
  if (typeof value === 'string')
    return shortenedText(value, Math.floor(value.length * scale));
  if (Array.isArray(value))
    return value.map((entry: unknown) => resultCopy(entry, scale));
  if (value !== null && typeof value === 'object') {
    const record = Object.fromEntries(Object.entries(value));
    const textKeys = ['text', 'stdout', 'stderr', 'output', 'content'];
    if (textKeys.some((key) => key in record))
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [
          key,
          textKeys.includes(key) ? resultCopy(item, scale) : item,
        ]),
      );
  }
  return jsonFragment(value, scale);
}

export function scaledUnit(
  unit: BudgetUnit,
  bodyScale = 1,
  argumentScale = 1,
): BudgetUnit {
  return {
    ...unit,
    ...(unit.events === undefined
      ? {}
      : {
          events: unit.events.map((event): ReviewEvent => {
            if (event.kind === 'call')
              return {
                ...event,
                arguments: jsonFragment(event.arguments, argumentScale),
              };
            if (event.kind === 'result' && event.body.state === 'present')
              return {
                ...event,
                body: {
                  ...event.body,
                  content: resultCopy(event.body.content, bodyScale),
                },
              };
            if (event.kind === 'assistant' || event.kind === 'checkpoint')
              return {
                ...event,
                text: shortenedText(
                  event.text,
                  Math.floor(event.text.length * bodyScale),
                ),
              };
            return event;
          }),
        }),
    ...(unit.context === undefined
      ? {}
      : {
          context: {
            ...unit.context,
            arguments:
              argumentScale >= 1
                ? unit.context.arguments
                : JSON.stringify(
                    jsonFragment(unit.context.arguments, argumentScale),
                  ),
            ...(argumentScale >= 1 ? {} : { argumentsTruncated: true }),
          },
        }),
    ...(unit.checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            ...unit.checkpoint,
            text: shortenedText(
              unit.checkpoint.text,
              Math.floor(unit.checkpoint.text.length * bodyScale),
            ),
          },
        }),
    ...(unit.hint === undefined
      ? {}
      : {
          hint: shortenedText(
            unit.hint,
            Math.floor(unit.hint.length * bodyScale),
          ),
        }),
  };
}

export function unitContent(unit: BudgetUnit): unknown {
  return (
    unit.events ??
    unit.evidence ??
    unit.context ??
    unit.checkpoint ??
    unit.prior ??
    unit.facts ??
    unit.hint
  );
}

export function addUnit(snapshot: Snapshot, unit: BudgetUnit): Snapshot {
  let prefix = snapshot.prefix;
  const area = unit.area;
  if (prefix !== undefined && area !== undefined && unit.events !== undefined) {
    const source = prefix[area];
    if (source !== null) {
      const byId = new Map(
        [...source.events, ...unit.events].map((event) => [
          event.eventId,
          event,
        ]),
      );
      prefix = {
        ...prefix,
        [area]: {
          ...source,
          events: [...byId.values()].sort((a, b) => a.seq - b.seq),
        },
      };
    }
  }
  return {
    ...snapshot,
    ...(prefix === undefined ? {} : { prefix }),
    ...(unit.evidence === undefined
      ? {}
      : { evidence: [...snapshot.evidence, unit.evidence] }),
    ...(unit.context === undefined
      ? {}
      : { context: [unit.context, ...snapshot.context] }),
    ...(unit.checkpoint === undefined
      ? {}
      : { checkpoints: [...snapshot.checkpoints, unit.checkpoint] }),
    ...(unit.prior === undefined
      ? {}
      : { priorVerdicts: [...snapshot.priorVerdicts, unit.prior] }),
    ...(unit.facts === undefined
      ? {}
      : { facts: appendFacts(snapshot.facts, unit.facts) }),
    ...(unit.hint === undefined ? {} : { hint: unit.hint }),
  };
}

export function baseSnapshot(snapshot: Snapshot): Snapshot {
  const { hint: _hint, ...rest } = snapshot;
  const local = newestOriginal(snapshot, 'session-human', 'human-instruction');
  const parent = newestOriginal(
    snapshot,
    'parent-human',
    'direct-parent-instruction',
  );
  return {
    ...rest,
    ...(snapshot.prefix === undefined
      ? {}
      : {
          prefix: {
            ...snapshot.prefix,
            local: {
              ...snapshot.prefix.local,
              events: snapshot.prefix.local.events.filter(
                (e) => e.protected === true,
              ),
            },
            parent:
              snapshot.prefix.parent === null
                ? null
                : {
                    ...snapshot.prefix.parent,
                    events: snapshot.prefix.parent.events.filter(
                      (e) => e.protected === true,
                    ),
                  },
          },
        }),
    evidence: snapshot.evidence.filter((e) => e === local || e === parent),
    context: [],
    checkpoints: [],
    priorVerdicts: [],
    facts: null,
  };
}

/** Append an admitted batch without copying a growing event array per unit. */
export function addUnits(
  snapshot: Snapshot,
  units: readonly BudgetUnit[],
): Snapshot {
  let prefix = snapshot.prefix;
  if (prefix !== undefined) {
    for (const area of ['local', 'parent'] as const) {
      const source: ReviewEventSource | null = prefix[area];
      if (source === null) continue;
      const incoming = units.flatMap((unit) =>
        unit.area === area ? (unit.events ?? []) : [],
      );
      const events: Map<string, ReviewEvent> = new Map(
        [...source.events, ...incoming].map((event) => [event.eventId, event]),
      );
      prefix = {
        ...prefix,
        [area]: {
          ...source,
          events: [...events.values()].sort((a, b) => a.seq - b.seq),
        },
      };
    }
  }
  const hints = units.flatMap((unit) =>
    unit.hint === undefined ? [] : [unit.hint],
  );
  const facts = units.reduce(
    (current, unit) =>
      unit.facts === undefined ? current : appendFacts(current, unit.facts),
    snapshot.facts,
  );
  return {
    ...snapshot,
    ...(prefix === undefined ? {} : { prefix }),
    facts,
    evidence: [
      ...snapshot.evidence,
      ...units.flatMap((unit) =>
        unit.evidence === undefined ? [] : [unit.evidence],
      ),
    ],
    context: [
      ...units
        .flatMap((unit) => (unit.context === undefined ? [] : [unit.context]))
        .reverse(),
      ...snapshot.context,
    ],
    checkpoints: [
      ...snapshot.checkpoints,
      ...units.flatMap((unit) =>
        unit.checkpoint === undefined ? [] : [unit.checkpoint],
      ),
    ],
    priorVerdicts: [
      ...snapshot.priorVerdicts,
      ...units.flatMap((unit) =>
        unit.prior === undefined ? [] : [unit.prior],
      ),
    ],
    ...(hints[0] === undefined ? {} : { hint: hints[0] }),
  };
}
