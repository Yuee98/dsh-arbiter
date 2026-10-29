/**
 * The material builder: current-turn window, cross-turn authorization, M0.
 *
 * What is pinned here, one concern per group:
 *
 *   - The tool window is the current turn's calls, oldest first, with the
 *     pending call excluded. Earlier turns contribute their authorization, not
 *     their tool calls.
 *   - Host turn identity is read, never invented: recovery, retry and a timed
 *     answer keep the turn the host recorded.
 *   - Human permissions and restrictions cross turns until something newer and
 *     applicable conflicts with them; a withdrawal is never the item dropped.
 *   - A call is an attempt; only a recorded result is an outcome.
 *   - The four kinds of gap stay separate, and only a real loss of required
 *     material makes the review insufficient.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import { materialAvailabilityOf } from '../src/snapshot.js';
import {
  buildReviewSnapshot,
  truncationFeedback,
  type SessionEventLike,
  type SessionLike,
} from '../src/snapshot.js';

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-material-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function userMessage(
  seq: number,
  time: number,
  source: Record<string, unknown>,
  text: string,
  turn?: number,
): SessionEventLike {
  return {
    seq,
    time,
    type: 'user/message',
    data: {
      source,
      content: [{ type: 'text', text }],
      ...(turn === undefined ? {} : { turn }),
    },
  };
}

function human(
  seq: number,
  time: number,
  text: string,
  turn?: number,
): SessionEventLike {
  return userMessage(
    seq,
    time,
    { kind: 'user', rpcId: `rpc-${String(seq)}` },
    text,
    turn,
  );
}

function turnStart(seq: number, time: number, turn: number): SessionEventLike {
  return { seq, time, type: 'turn/start', data: { turn } };
}

function turnEnd(seq: number, time: number, turn: number): SessionEventLike {
  return {
    seq,
    time,
    type: 'turn/end',
    data: { turn, reason: 'completed' },
  };
}

function toolCall(
  seq: number,
  time: number,
  callId: string,
  name: string,
  args: unknown,
  turn?: number,
): SessionEventLike {
  return {
    seq,
    time,
    type: 'tool/call',
    data: {
      callId,
      name,
      arguments: args,
      ...(turn === undefined ? {} : { turn, step: 1 }),
    },
  };
}

function toolResult(
  seq: number,
  time: number,
  callId: string,
  isError: boolean,
  turn?: number,
): SessionEventLike {
  return {
    seq,
    time,
    type: 'tool/result',
    data: {
      ...(turn === undefined ? {} : { turn, step: 1 }),
      message: {
        role: 'tool',
        toolCallId: callId,
        isError,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: isError ? 'error' : 'ok' }],
      },
    },
  };
}

function session(
  id: string,
  events: readonly SessionEventLike[],
  parentSession?: string,
): SessionLike {
  return {
    id,
    header: {
      id,
      ...(parentSession === undefined
        ? {}
        : { parentSession, origin: 'subagent', delegationDepth: 1 }),
    },
    snapshotEvents: () => events,
  };
}

const base = {
  tool: 'bash',
  arguments: { command: 'echo current' },
  callId: 'current',
  facts: null,
  priorVerdicts: [],
  sessionRecordGap: null,
  configRevision: 'test',
};

describe('current-turn tool window', () => {
  test('only the current turn contributes tool calls, oldest first', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'first task'),
      toolCall(3, 1, 'old-1', 'bash', { command: 'echo old-one' }, 1),
      toolResult(4, 1, 'old-1', false, 1),
      toolCall(5, 2, 'old-2', 'bash', { command: 'echo old-two' }, 1),
      toolResult(6, 2, 'old-2', false, 1),
      turnEnd(7, 2, 1),
      turnStart(8, 3, 2),
      human(9, 3, 'second task'),
      toolCall(10, 3, 'new-1', 'bash', { command: 'echo new-one' }, 2),
      toolResult(11, 3, 'new-1', true, 2),
      toolCall(12, 4, 'new-2', 'bash', { command: 'echo new-two' }, 2),
      toolResult(13, 4, 'new-2', false, 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.turn).toBe(2);
    expect(built.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo new-one"}',
      '{"command":"echo new-two"}',
    ]);
    // The last turn is the one in progress: a turn is closed by `turn/end`, so
    // the newest open turn is this call's, not the older one.
    expect(built.snapshot.context).toHaveLength(2);
    // The dropped earlier-turn calls are reported as an ordinary exclusion, not
    // as missing material.
    const exclusion = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'tool-window' && entry.kind === 'unrelated',
    );
    expect(exclusion?.blocking).toBe(false);
    expect(exclusion?.reason).toContain('2 earlier-turn tool call(s)');
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
  });

  test('the pending call is not part of its own history', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'clean the build'),
      toolCall(3, 2, 'earlier', 'bash', { command: 'echo earlier' }, 1),
      toolResult(4, 2, 'earlier', false, 1),
      toolCall(5, 3, 'current', 'bash', { command: 'echo current' }, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo earlier"}',
    ]);
    expect(
      built.snapshot.context.some((call) =>
        call.arguments.includes('echo current'),
      ),
    ).toBe(false);
  });

  test('the parent and the child tool windows stay separate', async () => {
    const cwd = await workspace();
    // Both sessions are in the same turn number, so a shared window would merge
    // them. Only the child's own calls are this call's history.
    const parentEvents: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'run the whole task'),
      toolCall(3, 2, 'parent-1', 'bash', { command: 'echo parent' }, 1),
      toolResult(4, 2, 'parent-1', false, 1),
    ];
    const parent = session('parent', parentEvents);
    const child = session(
      'child',
      [
        turnStart(1, 1, 1),
        userMessage(
          2,
          1,
          { kind: 'agent-message', senderSessionId: 'parent' },
          'do the delegated part',
          1,
        ),
        toolCall(3, 2, 'child-1', 'bash', { command: 'echo child' }, 1),
        toolResult(4, 2, 'child-1', false, 1),
      ],
      'parent',
    );
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: child },
      sessions: { get: (id) => (id === 'parent' ? parent : undefined) },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo child"}',
    ]);
    // The parent contributes authorization evidence, never its tool history.
    expect(
      built.snapshot.context.some((call) =>
        call.arguments.includes('echo parent'),
      ),
    ).toBe(false);
    expect(
      built.snapshot.evidence.some(
        (item) => item.source.kind === 'parent-human',
      ),
    ).toBe(true);
  });

  test('an attempt without a result carries no status', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'run both'),
      toolCall(3, 2, 'ran', 'bash', { command: 'echo ran' }, 1),
      toolResult(4, 2, 'ran', false, 1),
      toolCall(5, 3, 'never-finished', 'bash', { command: 'echo pending' }, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const byArgs = (fragment: string) =>
      built.snapshot.context.find((call) => call.arguments.includes(fragment));
    expect(byArgs('echo ran')?.result).toEqual({ ok: true });
    // No result was recorded, so the snapshot must not claim the call ran.
    expect(byArgs('echo pending')?.result).toBeUndefined();
  });

  test('a failed result is recorded as failed, not as success', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'try it'),
      toolCall(3, 2, 'failed', 'bash', { command: 'false' }, 1),
      toolResult(4, 2, 'failed', true, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.context[0]?.result).toEqual({ ok: false });
  });

  test('a log that names no turn says so instead of claiming all history', async () => {
    const cwd = await workspace();
    const main = session('main', [
      human(1, 1, 'clean the build'),
      toolCall(2, 2, 'a', 'bash', { command: 'echo a' }),
      toolResult(3, 2, 'a', false),
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.turn).toBeNull();
    // The attribution gap is reported alongside the exclusion that resulted from
    // it, so a reader sees both the loss and its cause.
    expect(
      built.snapshot.completeness.items.map((entry) => entry.reason).join(' '),
    ).toContain('named no turn');
    // Attribution is unknown, not a failure: no call is presented as current, so
    // the window is empty, and the review is not blocked by a limitation it
    // cannot fix.
    expect(built.snapshot.context).toEqual([]);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
  });

  test('an announced turn is used before the pending call is recorded', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'first'),
      toolCall(3, 2, 'old', 'bash', { command: 'echo old' }, 1),
      toolResult(4, 2, 'old', false, 1),
      turnEnd(5, 3, 1),
      turnStart(6, 4, 2),
      human(7, 4, 'second'),
      toolCall(8, 5, 'new', 'bash', { command: 'echo new' }, 2),
      toolResult(9, 5, 'new', false, 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      // The gate learned the turn from `turn/start`, before this call's own
      // event existed.
      turn: 2,
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.turn).toBe(2);
    expect(built.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo new"}',
    ]);
  });

  test('a resumed turn keeps the host turn instead of starting a new one', async () => {
    const cwd = await workspace();
    // A session that resumed mid-turn: the host replays the seed, then continues
    // the same turn. Nothing here is a new turn number.
    const events: SessionEventLike[] = [
      turnStart(1, 1, 3),
      human(2, 1, 'continue the work'),
      toolCall(3, 2, 'resumed-1', 'bash', { command: 'echo resumed' }, 3),
      toolResult(4, 2, 'resumed-1', false, 3),
      turnStart(5, 3, 3),
      human(6, 3, 'still the same turn'),
      toolCall(7, 4, 'resumed-2', 'bash', { command: 'echo again' }, 3),
      toolResult(8, 4, 'resumed-2', false, 3),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.turn).toBe(3);
    expect(built.snapshot.context).toHaveLength(2);
  });

  test('the tool window is capped by historyMaxItems, dropping the oldest', async () => {
    const cwd = await workspace();
    const calls = Array.from({ length: 6 }, (_, index) => [
      toolCall(
        10 + index * 2,
        10 + index,
        `c-${String(index)}`,
        'bash',
        { command: `echo ${String(index)}` },
        1,
      ),
      toolResult(11 + index * 2, 10 + index, `c-${String(index)}`, false, 1),
    ]).flat();
    const main = session('main', [
      turnStart(1, 1, 1),
      human(2, 1, 'run the steps'),
      ...calls,
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, historyMaxItems: 3 },
      },
    });
    expect(built.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo 3"}',
      '{"command":"echo 4"}',
      '{"command":"echo 5"}',
    ]);
    // A capacity cut is truncation, not missing material.
    expect(built.snapshot.contextTruncated).toBe(true);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
  });
});

describe('cross-turn authorization', () => {
  test('an older permission stays in effect and is marked with its turn', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'you may delete build artifacts in this workspace', 1),
      turnEnd(3, 1, 1),
      turnStart(4, 5, 2),
      human(5, 5, 'now clean them up', 2),
      toolCall(6, 6, 'current', 'bash', { command: 'rm -rf build' }, 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const older = built.snapshot.evidence.find((item) =>
      item.text.includes('you may delete'),
    );
    // Cross-turn authorization is evidence, not history: it survives the window.
    expect(older?.turn).toBe(1);
    expect(older?.evidence).toBe('explicit');
    expect(built.snapshot.evidence.some((item) => item.turn === 2)).toBe(true);
  });

  test('a withdrawal in a later turn is kept and marked with its own turn', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'delete everything under build', 1),
      turnEnd(3, 1, 1),
      turnStart(4, 5, 2),
      human(
        5,
        5,
        'actually do not delete anything; the build directory stays',
        2,
      ),
      toolCall(6, 6, 'current', 'bash', { command: 'rm -rf build' }, 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const withdrawal = built.snapshot.evidence.find((item) =>
      item.text.includes('do not delete'),
    );
    expect(withdrawal?.turn).toBe(2);
    // The newer instruction is the one the reviewer must apply; both remain
    // visible so the conflict is resolvable from the material itself.
    expect(
      built.snapshot.evidence.some((item) =>
        item.text.includes('delete everything'),
      ),
    ).toBe(true);
  });

  test('the newest human statement survives even a one-item evidence budget', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      ...Array.from({ length: 6 }, (_, index) =>
        human(index + 1, index + 1, `older instruction ${String(index)}`, 1),
      ),
      human(20, 20, 'this is the withdrawal: stop now', 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, evidenceMaxItems: 1 },
      },
    });
    expect(built.snapshot.evidence).toHaveLength(1);
    // Dropping the withdrawal would leave the reviewer applying a permit the
    // human has already reversed.
    expect(built.snapshot.evidence[0]?.text).toBe(
      'this is the withdrawal: stop now',
    );
    expect(built.snapshot.evidenceTruncated).toBe(true);
  });
});

describe('material completeness', () => {
  test('a readable session with no authorization is known-empty, not a failure', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      toolCall(2, 2, 'current', 'bash', { command: 'rm -rf /tmp/x' }, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const empty = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'session-human',
    );
    expect(empty?.kind).toBe('known-empty');
    expect(empty?.blocking).toBe(false);
    // The review can still be scored: an unauthorized action at low risk is A2,
    // which is a scored outcome, not a material problem.
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
    expect(materialAvailabilityOf(built.snapshot.completeness).status).toBe(
      'available',
    );
    expect(built.snapshot.parentAuthorizationPresent).toBeNull();
  });

  test('an unreadable session blocks instead of reading as empty', async () => {
    const cwd = await workspace();
    const broken: SessionLike = {
      id: 'main',
      header: { id: 'main' },
      snapshotEvents: () => {
        throw new Error('event log unreadable');
      },
    };
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: broken },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const gap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'session-human',
    );
    expect(gap?.kind).toBe('unreadable');
    expect(gap?.blocking).toBe(true);
    expect(built.snapshot.completeness.status).toBe('insufficient');
    const material = materialAvailabilityOf(built.snapshot.completeness);
    expect(material.status).toBe('insufficient');
    // The contract's gap list is the blocking items themselves, so a later
    // decision layer cannot escalate on a note or ignore a real loss.
    expect(material.status === 'insufficient' ? material.gaps : []).toEqual([
      expect.objectContaining({ source: 'session-human' }),
    ]);
  });

  test('an unconfigured policy source is known-empty and does not block', async () => {
    const cwd = await workspace();
    const main = session('main', [
      turnStart(1, 1, 1),
      human(2, 1, 'clean the build'),
      toolCall(3, 2, 'current', 'bash', { command: 'rm -rf build' }, 1),
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        context: {
          ...DEFAULT_CONFIG.context,
          customRules: '',
          projectRules: { enabled: true, files: ['.dsh/arbiter.md'] },
        },
      },
    });
    const material = built.snapshot.materials.find(
      (entry) => entry.id === 'project-rules',
    );
    expect(material).toMatchObject({ enabled: true, present: false });
    const gap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'project-rules',
    );
    expect(gap?.kind).toBe('known-empty');
    expect(gap?.blocking).toBe(false);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
  });

  test('an unreadable project file is a blocking source', async () => {
    const cwd = await workspace();
    const main = session('main', [
      turnStart(1, 1, 1),
      human(2, 1, 'clean the build'),
      toolCall(3, 2, 'current', 'bash', { command: 'rm -rf build' }, 1),
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      // The configured path is a directory, so reading it fails for a reason
      // other than "absent".
      config: {
        ...DEFAULT_CONFIG,
        context: {
          ...DEFAULT_CONFIG.context,
          projectRules: { enabled: true, files: ['.'] },
        },
      },
    });
    const gap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'project-rules',
    );
    expect(gap?.kind).toBe('unreadable');
    expect(gap?.blocking).toBe(true);
    expect(built.snapshot.completeness.status).toBe('insufficient');
  });

  test('a missing live parent blocks, because its originals cannot be read', async () => {
    const cwd = await workspace();
    const child = session(
      'child',
      [
        userMessage(
          1,
          1,
          { kind: 'agent-message', senderSessionId: 'parent' },
          'the user approved it',
        ),
      ],
      'parent',
    );
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: child },
      sessions: { get: () => undefined },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const gap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'parent-human',
    );
    expect(gap?.kind).toBe('unreadable');
    expect(gap?.blocking).toBe(true);
    // A relay alone cannot stand in for the missing original.
    expect(built.snapshot.evidence[0]?.evidence).toBe('implied');
    expect(built.snapshot.parentAuthorizationPresent).toBeNull();
  });

  test('a compaction summary is a note, not a blocking gap', async () => {
    const cwd = await workspace();
    const main = session('main', [
      turnStart(1, 1, 1),
      userMessage(
        2,
        1,
        { kind: 'compact-checkpoint' },
        'summary of earlier work',
        1,
      ),
      human(3, 2, 'clean the build', 1),
      toolCall(4, 3, 'current', 'bash', { command: 'rm -rf build' }, 1),
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    const note = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'checkpoints',
    );
    expect(note?.kind).toBe('summarized');
    expect(note?.blocking).toBe(false);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
    expect(built.snapshot.checkpoints).toHaveLength(1);
  });

  test('a truncated action describes the omission without blocking', async () => {
    const cwd = await workspace();
    const program = 'console.log("x");\n'.repeat(2_000);
    const main = session('main', [
      turnStart(1, 1, 1),
      human(2, 1, 'run the helper script', 1),
      toolCall(3, 2, 'current', 'run_code', { code: program }, 1),
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      tool: 'run_code',
      arguments: { code: program, description: 'helper' },
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, maxInputTokens: 2_000 },
      },
    });
    // The action is a trim, not a loss of required material: the omission is
    // described exactly and the original request is preserved separately.
    expect(built.snapshot.action.truncated?.field).toBe('code');
    const actionGap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'pending-action',
    );
    expect(actionGap?.kind).toBe('truncated');
    expect(actionGap?.blocking).toBe(false);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
    // The hint states the fact and offers recovery without making a decision.
    expect(truncationFeedback(built.snapshot)).toContain('splitting');
  });

  test('unrelated earlier-turn loss never blocks a normal review', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'do the task', 1),
      ...Array.from({ length: 4 }, (_, index) => [
        toolCall(
          10 + index * 2,
          1,
          `old-${String(index)}`,
          'bash',
          { command: `echo ${String(index)}` },
          1,
        ),
        toolResult(11 + index * 2, 1, `old-${String(index)}`, false, 1),
      ]).flat(),
      turnEnd(30, 2, 1),
      turnStart(31, 3, 2),
      human(32, 3, 'next step', 2),
      toolCall(33, 4, 'current', 'bash', { command: 'echo current' }, 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.context).toEqual([]);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
    // The exclusion is reported so a reader can tell it apart from "nothing ran".
    expect(
      built.snapshot.completeness.items.some(
        (entry) => entry.kind === 'unrelated',
      ),
    ).toBe(true);
    // It is not repeated in the reviewer's missing-input list: an ordinary
    // exclusion is not a gap.
    expect(built.snapshot.missing.join(' ')).not.toContain('earlier-turn');
  });

  test('a truncated human permission is reported with its source, not blocking', async () => {
    const cwd = await workspace();
    const long = `${'a'.repeat(4_050)} and never touch /etc`;
    const main = session('main', [
      turnStart(1, 1, 1),
      human(2, 1, long, 1),
      toolCall(3, 2, 'current', 'bash', { command: 'rm -rf build' }, 1),
    ]);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.evidence[0]?.truncated).toBe(true);
    // The omission is described exactly, so a reader can see the cut even after
    // the request is gone: source, kind, and the original length.
    expect(built.snapshot.evidence[0]?.originalLength).toBe(long.length);
    const gap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'session-human' && entry.kind === 'truncated',
    );
    expect(gap?.reason).toContain('truncated');
    // Truncation is an input fact, not a material failure: it does not decide
    // the permission conclusion and it does not by itself fail the review.
    expect(gap?.blocking).toBe(false);
    expect(built.snapshot.completeness.status).not.toBe('insufficient');
    expect(built.snapshot.missing.join(' ')).toContain('truncated');
  });
});

describe('human sources the host writes without rpcId', () => {
  test('a bare user source is original human input, not a spoofed message', async () => {
    const cwd = await workspace();
    // The host's ACP prompt bridge creates a plain `{ kind: 'user' }` message
    // with no `rpcId`; it is real human input and must not be dropped.
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      userMessage(
        2,
        1,
        { kind: 'user' },
        'delete build output, keep sources',
        1,
      ),
      toolCall(3, 2, 'current', 'bash', { command: 'rm -rf build' }, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.evidence[0]?.text).toBe(
      'delete build output, keep sources',
    );
    expect(built.snapshot.evidence[0]?.evidence).toBe('explicit');
    // A readable session with a real message is not "no human evidence".
    expect(
      built.snapshot.completeness.items.some(
        (item) =>
          item.kind === 'known-empty' && item.source === 'session-human',
      ),
    ).toBe(false);
  });

  test('a withdrawal without rpcId is kept and outranks the earlier grant', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      userMessage(
        2,
        1,
        { kind: 'user', rpcId: 'rpc-grant' },
        'you may delete build output',
        1,
      ),
      turnEnd(3, 1, 1),
      turnStart(4, 5, 2),
      userMessage(5, 5, { kind: 'user' }, 'do not delete anything any more', 2),
      toolCall(6, 6, 'current', 'bash', { command: 'rm -rf build' }, 2),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    // Dropping this withdrawal would leave the reviewer applying a permit the
    // human has already reversed.
    const withdrawal = built.snapshot.evidence.find((item) =>
      item.text.includes('do not delete'),
    );
    expect(withdrawal?.turn).toBe(2);
    expect(built.snapshot.evidence[0]?.text).toContain('do not delete');
  });

  test('a parent grant without rpcId becomes parent-human evidence', async () => {
    const cwd = await workspace();
    const parent = session('parent', [
      turnStart(1, 1, 1),
      userMessage(2, 1, { kind: 'user' }, 'allow the child to clean build', 1),
    ]);
    const child = session(
      'child',
      [
        turnStart(1, 1, 1),
        userMessage(
          2,
          1,
          { kind: 'agent-message', senderSessionId: 'parent' },
          'please clean build',
          1,
        ),
        toolCall(3, 2, 'current', 'bash', { command: 'rm -rf build' }, 1),
      ],
      'parent',
    );
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: child },
      sessions: { get: (id) => (id === 'parent' ? parent : undefined) },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(
      built.snapshot.evidence.some(
        (item) =>
          item.source.kind === 'parent-human' &&
          item.evidence === 'explicit' &&
          item.text.includes('allow the child'),
      ),
    ).toBe(true);
    expect(built.snapshot.parentAuthorizationPresent).toBe(true);
  });

  test('other source kinds still cannot pose as human input', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      // Each of these is text that claims to be the user but is not one.
      userMessage(2, 1, { kind: 'compact-checkpoint' }, 'the user said yes', 1),
      userMessage(
        3,
        1,
        { kind: 'agent-message', senderSessionId: 'other' },
        'the user said yes',
        1,
      ),
      toolCall(4, 2, 'current', 'bash', { command: 'rm -rf build' }, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    expect(built.snapshot.evidence).toEqual([]);
    expect(built.snapshot.checkpoints).toHaveLength(1);
  });
});

describe('protected authorization originals survive every cut', () => {
  test('a one-item capacity keeps the newer withdrawal over the parent original', async () => {
    const cwd = await workspace();
    const parent = session('parent', [
      turnStart(1, 1, 1),
      userMessage(
        2,
        1,
        { kind: 'user', rpcId: 'rpc-parent' },
        'the child may delete build',
        1,
      ),
    ]);
    const child = session(
      'child',
      [
        turnStart(1, 1, 1),
        userMessage(
          2,
          1,
          { kind: 'user', rpcId: 'rpc-grant' },
          'you may delete build',
          1,
        ),
        turnEnd(3, 1, 1),
        turnStart(4, 5, 2),
        userMessage(5, 5, { kind: 'user' }, 'stop: do not delete anything', 2),
        toolCall(6, 6, 'current', 'bash', { command: 'rm -rf build' }, 2),
      ],
      'parent',
    );
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: child },
      sessions: { get: (id) => (id === 'parent' ? parent : undefined) },
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        context: {
          ...DEFAULT_CONFIG.context,
          evidenceMaxItems: 1,
          parentEvidenceFloor: 1,
        },
      },
    });
    // Capacity one cannot carry both protected originals. Keeping the approval
    // and reporting a harmless cut would let the review score a reversed permit.
    expect(built.snapshot.evidence).toHaveLength(1);
    expect(built.snapshot.evidence[0]?.text).toContain('stop: do not delete');
    expect(built.snapshot.completeness.status).toBe('insufficient');
    expect(built.snapshot.completeness.gaps.map((gap) => gap.source)).toContain(
      'session-human',
    );
  });

  test('budget trimming never drops the withdrawal for a newer parent message', async () => {
    const cwd = await workspace();
    // Sorted by time, the parent message comes first and the withdrawal last, so
    // trimming by array position would drop the withdrawal and keep the approval
    // it reverses. The protected pair must survive, leaving only the older
    // unrelated filler eligible.
    const parent = session('parent', [
      turnStart(1, 1, 1),
      userMessage(
        50,
        50,
        { kind: 'user', rpcId: 'rpc-parent' },
        'the build directory may be removed. '.repeat(40),
        1,
      ),
    ]);
    const child = session(
      'child',
      [
        turnStart(1, 1, 1),
        userMessage(
          2,
          1,
          { kind: 'user', rpcId: 'rpc-old' },
          // Older than the withdrawal and unrelated to it: this is the item an
          // ordinary capacity cut should take.
          'earlier: keep the docs folder intact. '.repeat(30),
          1,
        ),
        userMessage(
          3,
          10,
          { kind: 'user', rpcId: 'rpc-withdraw' },
          'never delete the build directory: it holds the release artifacts. '.repeat(
            9,
          ),
          1,
        ),
        toolCall(4, 20, 'current', 'bash', { command: 'rm -rf build' }, 1),
      ],
      'parent',
    );
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: child },
      sessions: { get: (id) => (id === 'parent' ? parent : undefined) },
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        context: {
          ...DEFAULT_CONFIG.context,
          // Tight enough to force evidence trimming, so the trimmer must choose
          // which original to keep rather than dropping by position.
          maxInputTokens: 2_200,
          evidenceMaxItems: 10,
        },
      },
    });
    const texts = built.snapshot.evidence.map((item) => item.text).join('\n');
    expect(built.snapshot.budget.truncatedSegments).toContain('EVIDENCE');
    // The withdrawal is retained and a review can still see it.
    expect(texts).toContain('never delete the build directory');
    expect(built.snapshot.evidence.some((item) => item.turn === 1)).toBe(true);
  });
});

describe('a closed turn cannot become the current turn', () => {
  test('a finished turn contributes no tool history to a later call', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      turnStart(1, 1, 1),
      human(2, 1, 'clean the build', 1),
      toolCall(3, 2, 'old', 'bash', { command: 'rm -rf build/old' }, 1),
      toolResult(4, 2, 'old', false, 1),
      turnEnd(5, 3, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    // The newest bracket in the log is closed and no turn was announced, so the
    // attribution is unknown rather than "the finished turn is still current".
    expect(built.snapshot.turn).toBeNull();
    expect(built.snapshot.context).toEqual([]);
    const gap = built.snapshot.completeness.items.find(
      (entry) => entry.source === 'tool-window' && entry.kind === 'unreadable',
    );
    expect(gap?.reason ?? '').toContain('already closed');
  });

  test('an unattributed call before the open bracket is not current history', async () => {
    const cwd = await workspace();
    const events: SessionEventLike[] = [
      // Written before this turn's bracket and carrying no turn of its own.
      toolCall(1, 1, 'stray', 'bash', { command: 'echo stray' }),
      toolResult(2, 1, 'stray', false),
      turnStart(3, 2, 1),
      human(4, 2, 'now do the real work', 1),
      // Written inside the bracket, still without its own stamp.
      toolCall(5, 3, 'inside', 'bash', { command: 'echo inside' }),
      toolResult(6, 3, 'inside', false),
      toolCall(7, 4, 'current', 'bash', { command: 'echo current' }, 1),
    ];
    const main = session('main', events);
    const built = await buildReviewSnapshot({
      ...base,
      agent: { session: main },
      cwd,
      config: DEFAULT_CONFIG,
    });
    // The call inside the bracket is this turn's; the one before it is not.
    expect(built.snapshot.context.map((call) => call.arguments)).toEqual([
      '{"command":"echo inside"}',
    ]);
    expect(built.snapshot.completeness.items).toContainEqual(
      expect.objectContaining({ source: 'tool-window', kind: 'unrelated' }),
    );
  });
});
