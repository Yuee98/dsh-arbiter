import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildReviewSnapshot } from '../src/snapshot.js';
import type {
  SnapshotOptions,
  SessionEventLike,
  SessionLike,
} from '../src/snapshot.js';
import { readSessionLog, SOURCE_EVENT_LIMIT } from '../src/snapshot/log.js';
import { beforePending, hostEventSource } from '../src/snapshot/host-events.js';
import { SOURCE_BYTE_LIMIT } from '../src/snapshot/source-guard.js';
import {
  buildEventPrefix,
  prefixProtectedGaps,
} from '../src/snapshot/prefix.js';
import { resultBody } from '../src/snapshot/event-content.js';

function event(
  seq: number,
  type: string,
  data: unknown,
  time = 100 - seq,
): SessionEventLike {
  return { seq, type, data, time };
}
function human(
  seq: number,
  text: string,
  id = 'same-message',
): SessionEventLike {
  return event(seq, 'user/message', {
    id,
    source: { kind: 'user' },
    content: text,
  });
}
function assistant(seq: number, text: string): SessionEventLike {
  return event(seq, 'assistant/message', { message: { content: text } });
}
function call(
  seq: number,
  callId: string,
  args: unknown = { command: 'ls' },
  name = 'bash',
): SessionEventLike {
  return event(seq, 'tool/call', { turn: seq, callId, name, arguments: args });
}
function result(
  seq: number,
  callId: string,
  content: unknown,
  isError?: boolean,
): SessionEventLike {
  return event(seq, 'tool/result', {
    message: {
      source: { kind: 'tool', callId },
      content,
      ...(isError === undefined ? {} : { isError }),
    },
  });
}
function session(
  events: readonly SessionEventLike[],
  parentSession?: string,
): SessionLike {
  return {
    id: 'local',
    inheritedEventCount: 0,
    header: { ...(parentSession === undefined ? {} : { parentSession }) },
    snapshotEvents: () => events,
  };
}
function prefix(events: readonly SessionEventLike[]) {
  const log = readSessionLog(session(events));
  return buildEventPrefix(
    {
      local: hostEventSource(beforePending(log, 'pending'), 'local', 'parent'),
      parent: null,
    },
    'pending',
  );
}
const options: Omit<SnapshotOptions, 'agent'> = {
  tool: 'bash',
  arguments: { command: 'echo pending' },
  callId: 'pending',
  cwd: '/missing-cw123-fixture',
  config: {
    ...DEFAULT_CONFIG,
    context: {
      ...DEFAULT_CONFIG.context,
      maxInputTokens: 100_000,
      projectRules: { ...DEFAULT_CONFIG.context.projectRules, enabled: false },
    },
  },
  facts: null,
  priorVerdicts: [],
  sessionRecordGap: null,
  configRevision: 'fixture',
};

describe('native identities, cutoff and candidate ordering', () => {
  test('equal message IDs and equal text do not collapse distinct events or follow clocks', () => {
    const built = prefix([
      human(1, 'same'),
      human(2, 'same'),
      human(3, 'withdraw'),
    ]);
    expect(built.local.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(built.local.events.map((e) => e.eventId)).toEqual([
      '["local",1]',
      '["local",2]',
      '["local",3]',
    ]);
    expect(built.local.events.map((e) => e.messageId)).toEqual([
      'same-message',
      'same-message',
      'same-message',
    ]);
    expect(
      built.local.events.filter((e) => e.protected).map((e) => e.seq),
    ).toEqual([3]);
  });
  test('only the same event identity is deduplicated', () => {
    const duplicated = human(1, 'original');
    expect(
      prefix([duplicated, duplicated, human(2, 'original')]).local.events.map(
        (e) => e.seq,
      ),
    ).toEqual([1, 2]);
  });
  test('recorded pending is the exclusive local cutoff, even for late results and humans', () => {
    const built = prefix([
      human(0, 'initial'),
      call(1, 'old'),
      call(2, 'pending'),
      result(3, 'old', 'FUTURE_RESULT', false),
      human(4, 'FUTURE_HUMAN'),
    ]);
    expect(built.local.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(built.local.status.cutoff?.seq).toBe(1);
    expect(JSON.stringify(built)).not.toContain('FUTURE');
  });
  test('unrecorded pending is never history and cross-turn tools remain candidates', () => {
    const built = prefix([
      human(0, 'go'),
      call(1, 'one'),
      result(2, 'one', 'old output', false),
      call(3, 'two'),
    ]);
    expect(built.local.events.map((e) => e.kind)).toEqual([
      'human',
      'call',
      'result',
      'call',
    ]);
    expect(built.local.events.find((e) => e.kind === 'result')).toMatchObject({
      seq: 2,
      call: { eventId: '["local",1]', tool: 'bash' },
    });
  });
  test('nearest assistant before the newest human is context, never a guessed question', () => {
    const built = prefix([
      assistant(0, 'old?'),
      assistant(1, 'Publish everything?'),
      human(2, '可以'),
      assistant(3, 'after'),
    ]);
    expect(built.local.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(built.local.events[1]).not.toHaveProperty('binding');
    expect(built.local.events[0]?.protected).toBe(false);
  });
  test('without a local human no ordinary assistant qualifies', () => {
    expect(prefix([assistant(1, 'agent proposal')]).local.events).toEqual([]);
  });
  test('only latest readable checkpoint is considered and stays at its position', () => {
    const checkpoint = (seq: number) =>
      event(seq, 'user/message', {
        source: { kind: 'compact-checkpoint' },
        content: `summary ${String(seq)}`,
      });
    const built = prefix([
      checkpoint(0),
      human(1, 'actual'),
      checkpoint(2),
      call(3, 'old'),
    ]);
    expect(built.local.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(built.local.events[1]?.protected).toBe(false);
  });
});

describe('explicit host question binding', () => {
  test('answer IDs cannot bind a different question in the same ask batch', () => {
    const asked = call(
      1,
      'ask',
      {
        questions: [
          {
            id: 'q1',
            question: 'Only local?',
            options: [{ label: 'Yes', description: 'Never publish' }],
          },
        ],
      },
      'ask_user_question',
    );
    const reply = result(
      2,
      'ask',
      JSON.stringify({ answers: [{ id: 'wrong', selected: ['yes'] }] }),
      false,
    );
    const built = prefix([asked, reply]);
    expect(built.local.events[1]).toMatchObject({
      kind: 'human',
      binding: { status: 'unavailable' },
    });
    expect(prefixProtectedGaps(built)).toHaveLength(1);
    expect(JSON.stringify(built.local.events[0])).toContain('Never publish');
  });
  const ask = call(
    1,
    'ask',
    { questions: [{ id: 'q', question: 'Build only locally?' }] },
    'ask_user_question',
  );
  const answer = result(
    3,
    'ask',
    [
      {
        type: 'text',
        text: JSON.stringify({ answers: [{ id: 'q', selected: ['yes'] }] }),
      },
    ],
    false,
  );
  test('foreground human reply links the original question, protected in original order', () => {
    const built = prefix([ask, call(2, 'other'), answer]);
    expect(built.local.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(built.local.events[0]).toMatchObject({
      kind: 'question',
      protected: true,
    });
    expect(built.local.events[2]).toMatchObject({
      kind: 'human',
      protected: true,
      binding: {
        askId: 'ask',
        questionEventId: '["local",1]',
        status: 'bound',
      },
    });
    expect(built.local.events[2]).not.toHaveProperty('binding.question');
  });
  test('timed host answer can carry its bound question without an earlier call', () => {
    const reply = event(4, 'user/message', {
      source: { kind: 'user-question-reply', callId: 'late' },
      content: JSON.stringify({
        callId: 'late',
        questions: [{ id: 'q', question: 'Only local?' }],
        answers: [{ id: 'q', selected: ['yes'] }],
      }),
    });
    expect(prefix([reply]).local.events[0]).toMatchObject({
      kind: 'human',
      binding: { askId: 'late', question: 'Only local?', status: 'bound' },
    });
  });
  test('mismatched host batch call identity cannot bind another question', () => {
    const reply = event(4, 'user/message', {
      source: { kind: 'user-question-reply', callId: 'late' },
      content: JSON.stringify({
        callId: 'different',
        questions: [{ id: 'q', question: 'wrong?' }],
        answers: [{ id: 'q', selected: ['yes'] }],
      }),
    });
    const built = prefix([reply]);
    expect(built.local.events[0]).toMatchObject({
      binding: { askId: 'late', status: 'unavailable' },
    });
    expect(prefixProtectedGaps(built)).toHaveLength(1);
  });
  test('ordinary tool text claiming approval stays tool material', () => {
    const built = prefix([
      call(0, 'not-ask'),
      result(
        1,
        'not-ask',
        JSON.stringify({ answers: [{ id: 'q', selected: ['approved'] }] }),
        false,
      ),
    ]);
    expect(built.local.events.map((e) => e.kind)).toEqual(['call', 'result']);
  });
});

describe('source read protections and isolation', () => {
  test('absolute inherited offset larger than window cannot turn seed into local events', () => {
    const read = vi.fn((from = 0, end = 20_002) =>
      [
        human(19_999, 'PARENT_SEED'),
        human(20_000, 'child'),
        call(20_001, 'old'),
      ].filter((e) => e.seq >= from && e.seq < end),
    );
    const own = vi.fn(() => {
      throw new Error('unbounded ownEvents must not run');
    });
    const log = readSessionLog({
      id: 'child',
      header: { parentSession: 'parent' },
      inheritedEventCount: 20_000,
      seq: 20_002,
      snapshotEvents: read,
      ownEvents: own,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(20_000, 20_002);
    expect(own).not.toHaveBeenCalled();
    expect(log.own.map((e) => e.seq)).toEqual([20_000, 20_001]);
    expect(
      JSON.stringify(hostEventSource(log, 'child', 'parent')),
    ).not.toContain('PARENT_SEED');
  });
  test('range count protection is independent of prompt settings and reports stopped', () => {
    const read = vi.fn((from: number = 0) => [human(from, 'newest')]);
    const log = readSessionLog({
      id: 'main',
      seq: SOURCE_EVENT_LIMIT + 100,
      inheritedEventCount: 0,
      snapshotEvents: read,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(100, SOURCE_EVENT_LIMIT + 100);
    expect(log.coverage).toMatchObject({
      stopped: true,
      fromSeq: 100,
      access: 'range',
    });
  });
  test('missing subagent ownership boundary is unknown, never a local human seed', () => {
    const log = readSessionLog({
      id: 'child',
      header: { parentSession: 'parent' },
      snapshotEvents: () => [human(0, 'SEED')],
    });
    const source = hostEventSource(log, 'child', 'parent');
    expect(source.events).toEqual([]);
    expect(source.status.status).toBe('stopped');
    expect(source.status.reason).toContain('seed boundary');
  });
  test('byte guard finds latest human before scanning a huge ordinary result', () => {
    const built = prefix([
      human(0, 'keep actual original'),
      call(1, 'large'),
      result(2, 'large', 'x'.repeat(SOURCE_BYTE_LIMIT + 1), false),
    ]);
    expect(built.local.events).toContainEqual(
      expect.objectContaining({
        kind: 'human',
        text: 'keep actual original',
        protected: true,
      }),
    );
    expect(built.local.status.status).toBe('stopped');
    expect(prefixProtectedGaps(built)).toEqual([]);
  });
  test('oversized newest human cannot make an older human look like the protected newest', () => {
    const built = prefix([
      human(0, 'old'),
      human(1, 'x'.repeat(SOURCE_BYTE_LIMIT + 1)),
    ]);
    const gaps = prefixProtectedGaps(built);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.source).toBe('session-human');
    expect(gaps[0]?.reason).toContain('latest human');
  });
  test('known empty and unavailable reads remain different', () => {
    expect(
      hostEventSource(readSessionLog(session([])), 'main', undefined).status
        .status,
    ).toBe('known-empty');
    const read = vi.fn(() => {
      throw new Error('read failed');
    });
    const log = readSessionLog({ snapshotEvents: read });
    expect(read).toHaveBeenCalledTimes(2);
    expect(hostEventSource(log, 'main', undefined).status.status).toBe(
      'unavailable',
    );
  });
});

describe('result facts and whole-prefix snapshot integration', () => {
  test('JSON text cannot carry binary media through contiguous text blocks', () => {
    const json = JSON.stringify({
      count: 2,
      image: {
        type: 'image',
        data: 'BINARY_JSON_SENTINEL',
        image_url: { url: 'asset.png' },
      },
    });
    const body = resultBody({
      content: [
        { type: 'text', channel: 'stdout', text: json.slice(0, 35) },
        { type: 'text', channel: 'stdout', text: json.slice(35) },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('BINARY_JSON_SENTINEL');
    expect(JSON.stringify(body)).toContain('asset.png');
    expect(JSON.stringify(body)).toContain('not provided');
  });
  test('text channels stay separate and orphan results state their missing call', () => {
    const built = prefix([
      result(
        3,
        'missing',
        [
          { type: 'text', channel: 'stdout', text: 'out' },
          { type: 'text', channel: 'stderr', text: 'err' },
        ],
        true,
      ),
    ]);
    expect(built.local.events[0]).toMatchObject({
      kind: 'result',
      callUnavailable: 'not-observed',
      body: {
        state: 'present',
        content: [
          { type: 'text', channel: 'stdout', text: 'out' },
          { type: 'text', channel: 'stderr', text: 'err' },
        ],
      },
    });
  });
  test('captured snapshots do not change when structural source arguments change', async () => {
    const argumentsValue = { command: 'original source command' };
    const action = { command: 'original action' };
    const built = await buildReviewSnapshot({
      ...options,
      arguments: action,
      agent: { session: session([call(0, 'old', argumentsValue)]) },
    });
    argumentsValue.command = 'MUTATED_SOURCE';
    action.command = 'MUTATED_ACTION';
    expect(JSON.stringify(built.snapshot)).not.toContain('MUTATED');
    expect(built.snapshot.action.arguments).toEqual({
      command: 'original action',
    });
  });
  test('each review refreshes parent cutoff while an existing snapshot stays frozen', async () => {
    const events = [human(0, 'initial parent grant')];
    const parent = { ...session(events), id: 'parent' };
    const child = session([human(0, 'child')], 'parent');
    const input = {
      ...options,
      agent: { session: child },
      sessions: { get: () => parent },
    };
    const first = await buildReviewSnapshot(input);
    events.push(human(1, 'parent withdrawal'));
    const second = await buildReviewSnapshot(input);
    expect(first.user).not.toContain('parent withdrawal');
    expect(first.snapshot.prefix?.parent?.status.cutoff?.seq).toBe(0);
    expect(second.snapshot.prefix?.parent?.status.cutoff?.seq).toBe(1);
    expect(second.snapshot.prefix?.parent?.events.at(-1)).toMatchObject({
      kind: 'human',
      text: 'parent withdrawal',
      protected: true,
    });
  });
  test('unknown success flags stay unknown and results keep their observation positions', () => {
    const built = prefix([
      call(0, 'one'),
      human(1, 'human'),
      result(2, 'one', 'late'),
      call(3, 'two'),
    ]);
    expect(built.local.events[2]).toMatchObject({
      kind: 'result',
      seq: 2,
      status: 'unknown',
    });
    expect(built.local.events[0]).not.toHaveProperty('result');
  });
  test.each([true, false])(
    'observed failure flag %s is preserved',
    (isError) => {
      expect(
        prefix([call(0, 'c'), result(1, 'c', '', isError)]).local.events[1],
      ).toMatchObject({
        kind: 'result',
        status: isError ? 'failure' : 'success',
        body: { state: 'empty' },
      });
    },
  );
  test('media bodies and data URIs are omitted while mixed text and structured facts survive', () => {
    const body = resultBody({
      state: 'present',
      content: [
        { type: 'text', text: 'stdout real text' },
        { type: 'image', data: 'BASE64_SENTINEL', ref: 'asset.png' },
        {
          type: 'json',
          value: { count: 7, audio: 'data:audio/wav;base64,BINARY_SENTINEL' },
        },
      ],
    });
    expect(JSON.stringify(body)).toContain('stdout real text');
    expect(JSON.stringify(body)).toContain('asset.png');
    expect(JSON.stringify(body)).toContain('"count":7');
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
  });
  test.each(['lost', 'unreadable', 'not-provided'] as const)(
    'result body %s remains unavailable, not empty',
    (reason) => {
      expect(resultBody({ state: 'unavailable', reason })).toEqual({
        state: 'unavailable',
        reason,
      });
    },
  );
  test('new source entry ignores old 20/5/40 and text caps', async () => {
    const events = [
      ...Array.from({ length: 23 }, (_, i) =>
        human(i, i === 22 ? 'L'.repeat(5_000) : `human ${String(i)}`),
      ),
      ...Array.from({ length: 43 }, (_, i) => call(i + 23, `c${String(i)}`)),
    ];
    const built = await buildReviewSnapshot({
      ...options,
      agent: { session: session(events) },
      config: {
        ...options.config,
        context: {
          ...options.config.context,
          evidenceMaxItems: 1,
          historyMaxItems: 1,
          checkpointMaxItems: 0,
        },
      },
    });
    expect(
      built.snapshot.prefix?.local.events.filter((e) => e.kind === 'human'),
    ).toHaveLength(23);
    expect(built.snapshot.context).toHaveLength(43);
    expect(built.user).toContain('L'.repeat(5_000));
    expect(built.snapshot.completeness.gaps).toEqual([]);
  });
  test('parent humans stay in parent order, tools/siblings never enter local timeline', async () => {
    const parent = {
      ...session([
        human(0, 'parent first'),
        call(1, 'parent-tool'),
        human(2, 'parent latest'),
      ]),
      id: 'parent',
    };
    const local = session(
      [
        human(0, 'local first'),
        event(1, 'user/message', {
          source: { kind: 'agent-message', senderSessionId: 'sibling' },
          content: 'SIBLING',
        }),
        event(2, 'user/message', {
          source: { kind: 'agent-message', senderSessionId: 'parent' },
          content: 'relay',
        }),
        human(3, 'local latest'),
      ],
      'parent',
    );
    const built = await buildReviewSnapshot({
      ...options,
      agent: { session: local },
      sessions: { get: () => parent },
    });
    expect(built.snapshot.prefix?.parent?.events.map((e) => e.seq)).toEqual([
      0, 2,
    ]);
    expect(built.snapshot.prefix?.local.events.map((e) => e.seq)).toEqual([
      0, 2, 3,
    ]);
    expect(built.user.match(/parent latest/gu)).toHaveLength(1);
    expect(built.user).not.toContain('parent-tool');
    expect(built.user).not.toContain('SIBLING');
  });
  test('H bridge preserves latest original and explicit question, or reports OVER_BUDGET', async () => {
    const ask = call(
      1,
      'ask',
      { questions: [{ id: 'q', question: 'Protected question '.repeat(300) }] },
      'ask_user_question',
    );
    const answer = result(
      3,
      'ask',
      JSON.stringify({ answers: [{ id: 'q', selected: ['yes'] }] }),
      false,
    );
    const built = await buildReviewSnapshot({
      ...options,
      agent: { session: session([ask, call(2, 'old'), answer]) },
      config: {
        ...options.config,
        context: { ...options.config.context, maxInputTokens: 400 },
      },
    });
    expect(built.snapshot.budget.truncatedSegments).toContain('OVER_BUDGET');
    expect(built.snapshot.prefix?.local.events.map((e) => e.seq)).toEqual([
      1, 3,
    ]);
    expect(built.user).toContain('Protected question');
    expect(built.snapshot.prefix?.omissions).toContainEqual(
      expect.objectContaining({ cause: 'budget', count: 1 }),
    );
  });
});
