import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  prepareReviewSnapshot,
  type SessionLike,
  type SessionEventLike,
} from '../../src/snapshot.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'initial-delegation-'));
  roots.push(root);
  return root;
}
function user(
  seq: number,
  text: string,
  source: Record<string, unknown> = { kind: 'user' },
): SessionEventLike {
  return {
    seq,
    type: 'user/message',
    data: {
      role: 'user',
      id: `message-${String(seq)}`,
      source,
      content: [{ type: 'text', text }],
    },
  };
}
function session(
  events: SessionEventLike[],
  header: NonNullable<SessionLike['header']>,
  inherited = 0,
) {
  let reads = 0;
  return {
    id: header.id ?? 'child',
    header,
    inheritedEventCount: inherited,
    get seq() {
      return (events.at(-1)?.seq ?? -1) + 1;
    },
    snapshotEvents(from = 0, to = Number.MAX_SAFE_INTEGER) {
      reads += 1;
      return events.filter((event) => event.seq >= from && event.seq < to);
    },
    ownEvents: () => events.filter((event) => event.seq >= inherited),
    reads: () => reads,
  };
}
function options(child: SessionLike, parent: SessionLike) {
  return {
    agent: { session: child },
    sessions: { get: (id: string) => (id === parent.id ? parent : undefined) },
    tool: 'bash',
    arguments: { command: 'echo pending' },
    callId: 'pending',
    cwd: workspace(),
    config: {
      ...DEFAULT_CONFIG,
      context: {
        ...DEFAULT_CONFIG.context,
        projectRules: { enabled: false, files: [] },
      },
    },
    facts: null,
    priorVerdicts: [],
    sessionRecordGap: null,
    configRevision: 'delegation',
  };
}
for (const withReader of [false, true]) {
  test(`captures the initial delegated-event identity before bounding and freezes it across rebuilds (reader ${String(withReader)})`, async () => {
    const events: SessionEventLike[] = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      user(1, 'agent delegation only'),
      user(2, 'actual later human without an RPC field'),
      {
        seq: 3,
        type: 'tool/call',
        data: {
          callId: 'ask',
          name: 'ask_user_question',
          arguments: { questions: [{ id: 'scope', question: 'Only sample?' }] },
        },
      },
      {
        seq: 4,
        type: 'tool/result',
        data: {
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'ask' },
            toolCallId: 'ask',
            isError: false,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  answers: [{ id: 'scope', selected: ['yes'] }],
                }),
              },
            ],
          },
        },
      },
    ];
    const header = { id: 'child', origin: 'subagent', parentSession: 'parent' };
    const child = session(events, header);
    const parent = session(
      [
        user(0, 'original parent restriction', {
          kind: 'user',
          rpcId: 'real-parent',
        }),
      ],
      { id: 'parent' },
    );
    const input = options(child, parent);
    const prepared = await prepareReviewSnapshot({
      ...input,
      ...(withReader
        ? {
            toolResults: {
              discover: () => {},
              read: () => {
                throw new Error('no result receipt was supplied');
              },
            },
          }
        : {}),
    });
    const prefix = prepared.bundle.snapshot.prefix;
    expect(prefix?.local.events).toContainEqual(
      expect.objectContaining({
        kind: 'relay',
        source: 'parent-relay',
        senderSessionId: 'parent',
        seq: 1,
        text: 'agent delegation only',
      }),
    );
    expect(
      prefix?.local.events.filter((event) => event.kind === 'human'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'actual later human without an RPC field',
        }),
      ]),
    );
    const bound = prefix?.local.events.find(
      (event) => event.kind === 'human' && event.binding?.askId === 'ask',
    );
    expect(bound).toMatchObject({
      binding: {
        askId: 'ask',
        questionEventId: JSON.stringify(['child', 3]),
        answerIds: ['scope'],
        status: 'bound',
      },
    });
    expect(
      prefix?.local.events.some(
        (event) => event.kind === 'human' && event.seq === 1,
      ),
    ).toBe(false);
    expect(prefix?.parent?.events).toContainEqual(
      expect.objectContaining({
        source: 'parent-human',
        text: 'original parent restriction',
      }),
    );
    const readCount = child.reads() + parent.reads();
    header.origin = 'main';
    events.push(user(5, 'moving later source'));
    expect(prepared.rebuild().snapshot.prefix).toEqual(prefix);
    expect(child.reads() + parent.reads()).toBe(readCount);
  });
}

test('an inherited native own-start offset identifies the delegated message without relabelling inherited human input', async () => {
  const inherited = user(0, 'inherited human');
  const child = session(
    [
      inherited,
      { seq: 200, type: 'turn/start', data: { turn: 1 } },
      user(201, 'forked initial delegation'),
    ],
    { id: 'child', origin: 'subagent', parentSession: 'parent' },
    200,
  );
  const parent = session([inherited], { id: 'parent' });
  const prepared = await prepareReviewSnapshot(options(child, parent));
  expect(prepared.bundle.snapshot.prefix?.local.events).toEqual([
    expect.objectContaining({
      kind: 'relay',
      seq: 201,
      senderSessionId: 'parent',
    }),
  ]);
});

for (const origin of ['main', undefined, 'subagent']) {
  test(`preserves entry-point human input with native origin ${String(origin)}`, async () => {
    const child = session(
      [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        user(1, 'real human', { kind: 'user', rpcId: 'entry-point' }),
      ],
      {
        id: 'child',
        parentSession: 'parent',
        ...(origin === undefined ? {} : { origin }),
      },
    );
    const parent = session([], { id: 'parent' });
    const prepared = await prepareReviewSnapshot(options(child, parent));
    expect(prepared.bundle.snapshot.prefix?.local.events).toContainEqual(
      expect.objectContaining({
        kind: 'human',
        source: 'session-human',
        text: 'real human',
      }),
    );
    expect(
      prepared.bundle.snapshot.prefix?.local.events.some(
        (event) => event.kind === 'relay',
      ),
    ).toBe(false);
  });
}

test('the first visible human in a truncated native window is not guessed to be the initial delegation', async () => {
  const child = session(
    [
      user(800, 'later real human'),
      { seq: 17000, type: 'turn/start', data: { turn: 8 } },
    ],
    { id: 'child', origin: 'subagent', parentSession: 'parent' },
  );
  const parent = session([], { id: 'parent' });
  const prepared = await prepareReviewSnapshot(options(child, parent));
  // Use a human inside the actual bounded range (17001 - 16384 = 617).
  expect(prepared.bundle.snapshot.prefix?.local.status.status).toBe('stopped');
  expect(prepared.bundle.snapshot.prefix?.local.events).toContainEqual(
    expect.objectContaining({ kind: 'human', text: 'later real human' }),
  );
  expect(
    prepared.bundle.snapshot.prefix?.local.events.some(
      (event) => event.kind === 'relay',
    ),
  ).toBe(false);
});

test('a gap inside the native initial prefix does not promote its first visible user message into a delegation identity', async () => {
  const child = session(
    [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      user(8, 'later human after an unread initial message'),
    ],
    { id: 'child', origin: 'subagent', parentSession: 'parent' },
  );
  const parent = session([], { id: 'parent' });
  const prepared = await prepareReviewSnapshot(options(child, parent));
  expect(prepared.bundle.snapshot.prefix?.local.events).toContainEqual(
    expect.objectContaining({
      kind: 'human',
      text: 'later human after an unread initial message',
    }),
  );
  expect(
    prepared.bundle.snapshot.prefix?.local.events.some(
      (event) => event.kind === 'relay',
    ),
  ).toBe(false);
});
