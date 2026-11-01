import { describe, expect, test } from 'vitest';
import { estimateTokenCount } from 'tokenx';
import { DEFAULT_CONFIG, parseConfig } from '../src/config.js';
import { buildReviewSnapshot, prepareReviewSnapshot } from '../src/snapshot.js';
import type { SnapshotOptions } from '../src/snapshot.js';
import type { ReviewEvent, ReviewSnapshot } from '../src/types.js';
import { PRODUCTION_PACKAGE } from '../src/reviewer/package.js';
import { truncateSnapshot } from '../src/snapshot/budget.js';
import { buildEventPrefix } from '../src/snapshot/prefix.js';
import {
  renderChatRequest,
  renderDecisionRequest,
  renderChatUser,
} from '../src/reviewer/prompt.js';
import { shortenedText, textFragment } from '../src/snapshot/budget-text.js';

function human(seq: number, text: string): ReviewEvent {
  return {
    kind: 'human',
    source: 'session-human',
    sessionId: 'local',
    seq,
    eventId: `h${String(seq)}`,
    turnId: String(seq),
    text,
  };
}
function tool(seq: number, id: string, body = 'observed'): ReviewEvent[] {
  const identity = { sessionId: 'local', turnId: String(seq) };
  return [
    {
      ...identity,
      seq,
      eventId: `call-${id}`,
      kind: 'call',
      callId: id,
      tool: 'bash',
      arguments: {
        command: `echo START_${id} ${'argument '.repeat(300)} END_${id}`,
      },
    },
    {
      ...identity,
      seq: seq + 1,
      eventId: `result-${id}`,
      kind: 'result',
      callId: id,
      status: 'failure',
      exitCode: 4,
      body: {
        state: 'present',
        content: [
          {
            type: 'text',
            channel: 'stdout',
            text: `HEAD ${body} ${'result line\n'.repeat(500)} TAIL`,
          },
          { type: 'text', channel: 'stderr', text: 'actual stderr' },
        ],
      },
    },
    {
      ...identity,
      seq: seq + 2,
      eventId: `late-${id}`,
      kind: 'result',
      callId: id,
      status: 'unknown',
      body: {
        state: 'present',
        content: { stdout: 'late channel', stderr: 'late error' },
      },
    },
  ];
}
function options(
  events: readonly ReviewEvent[],
  target = 6000,
  hard = 10000,
): SnapshotOptions {
  return {
    agent: { session: { id: 'local', snapshotEvents: () => [] } },
    eventSources: {
      local: {
        status: {
          sessionId: 'local',
          status: 'complete',
          cutoff:
            events.length === 0
              ? null
              : { eventId: 'end', seq: Math.max(...events.map((e) => e.seq)) },
          fromSeq: 0,
          reason: null,
          access: 'declared',
        },
        events,
      },
      parent: null,
    },
    tool: 'bash',
    arguments: { command: 'echo pending' },
    callId: 'pending',
    cwd: '/budget-fixture',
    config: {
      ...DEFAULT_CONFIG,
      context: {
        ...DEFAULT_CONFIG.context,
        targetInputTokens: target,
        maxInputTokens: hard,
        projectRules: { enabled: false, files: [] },
      },
    },
    facts: null,
    priorVerdicts: [],
    sessionRecordGap: null,
    configRevision: 'budget-test',
  };
}
function actual(snapshot: ReviewSnapshot): number {
  return Math.max(
    renderChatRequest(snapshot).estimatedInputTokens,
    renderDecisionRequest(renderChatUser(snapshot)).estimatedInputTokens,
  );
}

const invalid = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
describe('T/H configuration normalization', () => {
  test('defaults, equality and old missing T respect the same H', () => {
    expect(parseConfig({}).config.context).toMatchObject({
      targetInputTokens: 6000,
      maxInputTokens: 10000,
    });
    expect(
      parseConfig({ context: { maxInputTokens: 4000 } }).config.context
        .targetInputTokens,
    ).toBe(4000);
    expect(
      parseConfig({ context: { targetInputTokens: 1, maxInputTokens: 1 } })
        .errors,
    ).toEqual([]);
    expect(
      parseConfig({
        context: { targetInputTokens: 6001, maxInputTokens: 6000 },
      }).errors,
    ).toContainEqual(
      expect.objectContaining({
        path: 'context.targetInputTokens',
        code: 'relation.targetInputTokens',
      }),
    );
  });
  test.each(invalid)('rejects explicit target %s', (value) => {
    expect(
      parseConfig({ context: { targetInputTokens: value } }).errors.some(
        (e) => e.path === 'context.targetInputTokens',
      ),
    ).toBe(true);
    expect(
      parseConfig({ context: { maxInputTokens: value } }).errors.some(
        (e) => e.path === 'context.maxInputTokens',
      ),
    ).toBe(true);
  });
  test('retired keys are ignored rather than mapped to normalized resource limits', () => {
    const parsed = parseConfig({
      context: {
        evidenceMaxItems: -1,
        parentHumanItems: 'old',
        parentEvidenceFloor: 50,
        historyMaxItems: 1,
        checkpointMaxItems: 40,
        toolCallArgumentMaxChars: null,
        customRules: 'long '.repeat(2000),
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(Object.keys(parsed.config.context).sort()).toEqual([
      'customRules',
      'maxInputTokens',
      'projectRules',
      'targetInputTokens',
    ]);
    expect(parsed.config.reviewer.chat.maxTokens).toBe(
      DEFAULT_CONFIG.reviewer.chat.maxTokens,
    );
  });
});

describe('one complete request budget for both protocols', () => {
  test('B=T and T<B=H follow distinct non-refill branches', async () => {
    const events = [human(0, 'original'), ...tool(1, 'old')];
    const base = await buildReviewSnapshot(options(events, 1, 100000));
    const b = base.snapshot.budget.baseInputTokens;
    if (b === undefined) throw new Error('missing base measurement');
    const equal = await buildReviewSnapshot(options(events, b, b));
    expect(actual(equal.snapshot)).toBeLessThanOrEqual(b);
    expect(equal.snapshot.budget.targetExceededReason).toBeUndefined();
    expect(equal.snapshot.budget.units).toEqual([]);
    const above = await buildReviewSnapshot(options(events, b - 1, b));
    expect(above.snapshot.budget.targetExceededReason).toBe('base-input');
    expect(above.snapshot.prefix?.local.events.map((e) => e.kind)).toEqual([
      'human',
    ]);
    expect(actual(above.snapshot)).toBe(b);
  });
  test('hard degradation shrinks global guidance first, preserves action and does not refill', async () => {
    const input = options(
      [human(0, 'protected original'), ...tool(1, 'old')],
      3000,
      5000,
    );
    const built = await buildReviewSnapshot({
      ...input,
      config: {
        ...input.config,
        context: {
          ...input.config.context,
          customRules:
            'GLOBAL_HEAD\n' +
            'global instruction\n'.repeat(5000) +
            '\nGLOBAL_TAIL',
        },
      },
    });
    expect(built.snapshot.budget.targetExceededReason).toBe('hard-degradation');
    expect(built.snapshot.action.arguments).toEqual(input.arguments);
    expect(built.snapshot.customRules).toContain('GLOBAL_HEAD');
    expect(built.snapshot.customRules).toContain('GLOBAL_TAIL');
    expect(built.snapshot.prefix?.local.events.map((e) => e.kind)).toEqual([
      'human',
    ]);
    expect(actual(built.snapshot)).toBeLessThanOrEqual(5000);
    expect(built.snapshot.completeness.gaps).toEqual([]);
  });
  test('protected original exceeding H remains whole with an explicit preparation failure', async () => {
    const text = 'protected actual human restriction\n'.repeat(4000);
    const built = await buildReviewSnapshot(
      options([human(0, text)], 6000, 10000),
    );
    expect(built.snapshot.prefix?.local.events[0]).toMatchObject({
      text,
      protected: true,
    });
    expect(built.snapshot.budget.truncatedSegments).toContain('OVER_BUDGET');
    expect(built.snapshot.budget.units).toEqual([]);
  });
  test.each([2, 20])(
    '%s calls share the ordinary target; each call and all channels share C',
    async (count) => {
      const events = [
        human(0, 'run the task'),
        ...Array.from({ length: count }, (_, i) =>
          tool(i * 3 + 1, `c${String(i)}`),
        ).flat(),
      ];
      const built = await buildReviewSnapshot(options(events));
      expect(actual(built.snapshot)).toBeLessThanOrEqual(6000);
      const calls =
        built.snapshot.prefix?.local.events.filter((e) => e.kind === 'call') ??
        [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const group =
          built.snapshot.prefix?.local.events.filter(
            (e) =>
              (e.kind === 'call' ||
                e.kind === 'result' ||
                e.kind === 'settlement') &&
              e.callId === call.callId,
          ) ?? [];
        const prefix = built.snapshot.prefix;
        if (prefix === undefined) throw new Error('missing prefix');
        const ids = new Set(group.map((event) => event.eventId));
        const without = {
          ...built.snapshot,
          prefix: {
            ...prefix,
            local: {
              ...prefix.local,
              events: prefix.local.events.filter(
                (event) => !ids.has(event.eventId),
              ),
            },
          },
        };
        const chatCost =
          renderChatRequest(built.snapshot).estimatedInputTokens -
          renderChatRequest(without).estimatedInputTokens;
        const decisionCost =
          renderDecisionRequest(renderChatUser(built.snapshot))
            .estimatedInputTokens -
          renderDecisionRequest(renderChatUser(without)).estimatedInputTokens;
        expect(Math.max(chatCost, decisionCost)).toBeLessThanOrEqual(600);
        expect(group).toHaveLength(3);
        expect(estimateTokenCount(JSON.stringify(group))).toBeLessThanOrEqual(
          600,
        );
        const note = built.snapshot.budget.units?.find(
          (u) => u.id === `local:call:${call.callId}`,
        );
        expect(note?.cap).toBeLessThanOrEqual(600);
        expect(note?.tokens).toBeLessThanOrEqual(note?.cap ?? 0);
        expect(JSON.stringify(group)).toContain('stderr');
        expect(JSON.stringify(group)).toContain('stdout');
        expect(JSON.stringify(group)).toContain('failure');
        expect(JSON.stringify(group)).toContain('json-fragment');
      }
      expect(built.user).not.toContain('baseInputTokens');
      expect(built.user).not.toContain('max_input_tokens');
    },
  );
  test('assistant, checkpoint and hint obey C while a large protected human stays whole', async () => {
    const text = 'actual human restriction '.repeat(350);
    const metadata = { sessionId: 'local', turnId: '1' };
    const events: ReviewEvent[] = [
      {
        ...metadata,
        kind: 'assistant',
        seq: 0,
        eventId: 'assistant',
        text:
          'ASSISTANT_HEAD\n' +
          'ordinary assistant line\n'.repeat(1000) +
          'ASSISTANT_TAIL',
      },
      human(1, text),
      {
        ...metadata,
        kind: 'checkpoint',
        seq: 2,
        eventId: 'checkpoint',
        text:
          'CHECKPOINT_HEAD\n' +
          'lossy summary\n'.repeat(1000) +
          'CHECKPOINT_TAIL',
      },
    ];
    const built = await buildReviewSnapshot({
      ...options(events),
      hint: 'HINT_HEAD\n' + 'ordinary hint\n'.repeat(1000) + 'HINT_TAIL',
    });
    expect(built.user).toContain(text);
    expect(actual(built.snapshot)).toBeLessThanOrEqual(6000);
    expect(built.snapshot.budget.units?.map((unit) => unit.id)).toEqual([
      'local:event:assistant',
      'hint',
      'local:event:checkpoint',
    ]);
    for (const unit of built.snapshot.budget.units ?? []) {
      expect(unit.cap).toBeLessThanOrEqual(600);
      expect(unit.tokens).toBeLessThanOrEqual(unit.cap ?? 0);
    }
    for (const marker of [
      'ASSISTANT_HEAD',
      'ASSISTANT_TAIL',
      'HINT_HEAD',
      'HINT_TAIL',
      'CHECKPOINT_HEAD',
      'CHECKPOINT_TAIL',
    ])
      expect(built.user).toContain(marker);
  });
  test('action head/tail truncation synchronizes both program copies and records the missing middle', async () => {
    const program =
      'PROGRAM_HEAD\n' +
      'console.log("ordinary program");\n'.repeat(3000) +
      '\nPROGRAM_TAIL';
    const input = options([human(0, 'run the program')], 3000, 4500);
    const built = await buildReviewSnapshot({
      ...input,
      tool: 'run_code',
      arguments: { program },
    });
    expect(built.snapshot.budget.targetExceededReason).toBe('hard-degradation');
    const args = built.snapshot.action.arguments;
    expect(args).toMatchObject({ program: built.snapshot.action.programText });
    expect(built.snapshot.action.programText).toContain('PROGRAM_HEAD');
    expect(built.snapshot.action.programText).toContain('PROGRAM_TAIL');
    expect(built.snapshot.action.truncated?.omittedFrom).toBeGreaterThan(0);
    expect(built.snapshot.action.truncated?.omittedTo).toBeLessThan(
      program.length - 1,
    );
    expect(actual(built.snapshot)).toBeLessThanOrEqual(4500);
    expect(program).toHaveLength(
      'PROGRAM_HEAD\n'.length +
        'console.log("ordinary program");\n'.length * 3000 +
        '\nPROGRAM_TAIL'.length,
    );
  });
  test('older humans beyond 20, tools beyond 40, and earlier turns remain eligible with room', async () => {
    const events = [
      ...Array.from({ length: 24 }, (_, i) =>
        human(i, `original ${String(i)}`),
      ),
      ...Array.from({ length: 45 }, (_, i): ReviewEvent => ({
        kind: 'call',
        sessionId: 'local',
        seq: i + 24,
        eventId: `old${String(i)}`,
        turnId: '1',
        callId: `old${String(i)}`,
        tool: 'bash',
        arguments: { command: 'echo useful old fact' },
      })),
    ];
    const built = await buildReviewSnapshot(options(events, 100000, 100000));
    expect(built.snapshot.evidence).toHaveLength(24);
    expect(built.snapshot.context).toHaveLength(45);
    expect(built.snapshot.prefix?.local.events[0]).toMatchObject({ seq: 0 });
  });
  test('frozen rebuild keeps T/H, sources and original action arguments', async () => {
    const events = [human(0, 'actual original'), ...tool(1, 'captured')];
    const input = options(events);
    const prepared = await prepareReviewSnapshot(input);
    events.push(human(100, 'later human'));
    const rebuilt = prepared.rebuild(['synthetic-known-credential']);
    expect(rebuilt.snapshot.prefix?.local.status.cutoff).toEqual(
      prepared.bundle.snapshot.prefix?.local.status.cutoff,
    );
    expect(rebuilt.user).not.toContain('later human');
    expect(rebuilt.snapshot.budget.targetInputTokens).toBe(6000);
    expect(input.arguments).toEqual({ command: 'echo pending' });
    expect(actual(rebuilt.snapshot)).toBeLessThanOrEqual(10000);
  });
  test('renderer callbacks are captured for frozen rebuilds', async () => {
    const renderers = {
      renderChat: PRODUCTION_PACKAGE.renderChat,
      renderDecision: PRODUCTION_PACKAGE.renderDecision,
    };
    const prepared = await prepareReviewSnapshot({
      ...options([human(0, 'actual original')]),
      budgetRenderers: renderers,
    });
    renderers.renderChat = () => {
      throw new Error('changed renderer must not be consulted');
    };
    const rebuilt = prepared.rebuild(['synthetic-known']);
    expect(rebuilt.user).toBe(prepared.bundle.user);
    expect(actual(rebuilt.snapshot)).toBeLessThanOrEqual(6000);
  });
  test('a candidate package is measured by its actual renderer pair', async () => {
    const input = options([human(0, 'original'), ...tool(1, 'old')]);
    const suffix = '\nactual experiment wrapper '.repeat(100);
    const pair = {
      renderChat: (snapshot: ReviewSnapshot) => {
        const request = PRODUCTION_PACKAGE.renderChat(snapshot);
        return {
          ...request,
          user: request.user + suffix,
          estimatedInputTokens:
            request.estimatedInputTokens + estimateTokenCount(suffix),
        };
      },
      renderDecision: PRODUCTION_PACKAGE.renderDecision,
    };
    const built = await buildReviewSnapshot({
      ...input,
      budgetRenderers: pair,
    });
    expect(
      pair.renderChat(built.snapshot).estimatedInputTokens,
    ).toBeLessThanOrEqual(6000);
    expect(built.user).toContain('actual experiment wrapper');
  });
});

describe('valid head/tail fragments', () => {
  test.each([0, 1, 2, 3, 20, 60])(
    'retains at most %s original UTF-16 units without splitting Unicode',
    (keep) => {
      const text = 'HEAD😀\n' + 'middle😀\n'.repeat(20) + 'TAIL😀';
      const fragment = textFragment(text, keep);
      expect(fragment.retainedChars).toBeLessThanOrEqual(keep);
      expect(JSON.parse(JSON.stringify(fragment))).toEqual(fragment);
      expect(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          fragment.head,
        ),
      ).toBe(true);
      expect(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          fragment.tail,
        ),
      ).toBe(true);
      expect(shortenedText(text, keep)).toContain('omitted by input budget');
    },
  );
});

test('distinct event and call identifiers cannot merge a human into an uncapped tool unit', async () => {
  const older = { ...human(0, 'older real human'), eventId: 'call:collision' };
  const built = await buildReviewSnapshot(
    options([older, ...tool(1, 'collision'), human(5, 'latest real human')]),
  );
  expect(built.snapshot.evidence.map((item) => item.text)).toContain(
    'older real human',
  );
  expect(
    built.snapshot.budget.units?.find(
      (unit) => unit.id === 'local:call:collision',
    )?.cap,
  ).toBe(600);
  const events =
    built.snapshot.prefix?.local.events.filter(
      (event) => event.kind === 'call' || event.kind === 'result',
    ) ?? [];
  expect(events).toHaveLength(3);
  expect(estimateTokenCount(JSON.stringify(events))).toBeLessThanOrEqual(600);
});

test('the allocator admits the full bounded population through batched full renders after preparation', async () => {
  const events: ReviewEvent[] = [
    human(0, 'actual original'),
    ...Array.from({ length: 16000 }, (_, index): ReviewEvent => ({
      kind: 'call',
      callId: `batch-${String(index)}`,
      eventId: `batch-event-${String(index)}`,
      sessionId: 'local',
      turnId: '1',
      seq: index + 1,
      tool: 'bash',
      arguments: { command: 'echo actual historical observation' },
    })),
  ];
  const prepared = await buildReviewSnapshot(
    options([human(0, 'actual original')], 5000000, 5000000),
  );
  const sources = options(events).eventSources;
  if (sources === undefined) throw new Error('missing source fixture');
  const { budget: _budget, ...base } = prepared.snapshot;
  const built = truncateSnapshot(
    { ...base, prefix: buildEventPrefix(sources, 'pending') },
    5000000,
    {
      truncatedHumanEvidence: false,
      protectedEvidenceDropped: [],
      historyTruncated: false,
      sessionReadable: true,
      sessionError: null,
      parentRequired: false,
      parentReadable: false,
      parentLive: false,
      parentError: null,
      compaction: false,
      parentCompaction: false,
      projectRules: { enabled: false, present: false, missing: null },
      sessionRecordGap: null,
      historyGap: [],
      evidenceCount: 1,
      earlierTurnCalls: 0,
      windowGap: null,
      hasToolCalls: true,
    },
    5000000,
  );
  expect(built.snapshot.context).toHaveLength(16000);
  expect(built.snapshot.budget.units).toHaveLength(16000);
  expect(actual(built.snapshot)).toBeLessThanOrEqual(5000000);
  expect(built.snapshot.prefix?.omissions).toEqual([]);
}, 15000);
