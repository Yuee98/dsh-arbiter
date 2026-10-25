import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import {
  buildReviewSnapshot,
  type SessionEventLike,
  type SessionLike,
} from '../src/snapshot.js';

function userEvent(
  seq: number,
  time: number,
  source: Record<string, unknown>,
  text: string,
): SessionEventLike {
  return {
    seq,
    time,
    type: 'user/message',
    data: { source, content: [{ type: 'text', text }] },
  };
}

const parent: SessionLike = {
  id: 'parent',
  header: { id: 'parent' },
  snapshotEvents: () => [
    userEvent(
      1,
      5,
      { kind: 'user', rpcId: 'r0' },
      'delete the build directory, keep the rest',
    ),
  ],
};

const child: SessionLike = {
  id: 'child',
  header: {
    id: 'child',
    parentSession: 'parent',
    origin: 'subagent',
    delegationDepth: 1,
  },
  snapshotEvents: () => [
    userEvent(1, 10, { kind: 'user', rpcId: 'r1' }, 'run the child task'),
    userEvent(
      2,
      20,
      { kind: 'agent-message', senderSessionId: 'parent' },
      'father says approved',
    ),
    userEvent(3, 25, { kind: 'compact-checkpoint' }, 'earlier summary'),
    {
      seq: 4,
      time: 30,
      type: 'tool/call',
      data: {
        callId: 'old',
        name: 'bash',
        arguments: '{"command":"echo old"}',
      },
    },
    {
      seq: 5,
      time: 40,
      type: 'tool/call',
      data: {
        callId: 'current',
        name: 'bash',
        arguments: '{"command":"echo current"}',
      },
    },
  ],
};

describe('review snapshot', () => {
  test('collects sourced evidence, parent evidence, relay and prior context', async () => {
    const built = await buildReviewSnapshot({
      agent: { session: child },
      sessions: { get: (id) => (id === 'parent' ? parent : undefined) },
      tool: 'bash',
      arguments: { command: 'echo current' },
      callId: 'current',
      cwd: '/tmp/arbiter-snapshot-test',
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      hint: 'watch the target',
    });
    const { snapshot } = built;
    expect(snapshot.sessionKind).toBe('subagent');
    expect(snapshot.parentAuthorizationPresent).toBe(true);
    expect(snapshot.hint).toBe('watch the target');
    expect(snapshot.evidence.map((item) => item.source.kind)).toEqual(
      expect.arrayContaining(['session-human', 'parent-human', 'parent-relay']),
    );
    expect(
      snapshot.evidence.find((item) => item.source.kind === 'session-human')
        ?.evidence,
    ).toBe('explicit');
    expect(
      snapshot.evidence.find((item) => item.source.kind === 'parent-relay')
        ?.evidence,
    ).toBe('implied');
    expect(snapshot.checkpoints).toHaveLength(1);
    expect(snapshot.context.map((item) => item.arguments)).toEqual([
      '{"command":"echo old"}',
    ]);
    expect(built.user).toContain('REVIEW_HINT');
    expect(built.user).toContain('watch the target');
  });

  test('marks a truncated human message and exposes missing input to the reviewer', async () => {
    const text = `${'a'.repeat(4_050)} Do not send anything outside this machine.`;
    const session: SessionLike = {
      id: 'long-session',
      header: { id: 'long-session' },
      snapshotEvents: () => [
        userEvent(1, 1, { kind: 'user', rpcId: 'r' }, text),
      ],
    };
    const built = await buildReviewSnapshot({
      agent: { session },
      tool: 'bash',
      arguments: { command: 'echo harmless' },
      callId: 'call',
      cwd: '/tmp/arbiter-snapshot-test',
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
    });
    const item = built.snapshot.evidence[0];
    expect(item?.truncated).toBe(true);
    expect(item?.originalLength).toBe(text.length);
    expect(item?.text.length).toBe(4_000);
    expect(built.snapshot.evidenceTruncated).toBe(true);
    expect(built.snapshot.missing.join(' ')).toContain('truncated');
    expect(built.user).toContain('MISSING_INPUT');
    expect(built.user).toContain('truncated');
  });

  test('truncates evidence but never the pending action', async () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      userEvent(
        index + 1,
        index,
        { kind: 'user', rpcId: `r-${String(index)}` },
        'x'.repeat(400),
      ),
    );
    const session: SessionLike = {
      id: 'session',
      header: { id: 'session' },
      snapshotEvents: () => many,
    };
    const built = await buildReviewSnapshot({
      agent: { session },
      tool: 'bash',
      arguments: { command: 'echo KEEP_THIS_PENDING_ACTION' },
      callId: 'call',
      cwd: '/tmp/arbiter-snapshot-test',
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, maxInputTokens: 1_600 },
      },
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
    });
    expect(built.snapshot.evidence.length).toBeLessThan(40);
    expect(built.snapshot.budget.truncatedSegments).toContain('EVIDENCE');
    expect(built.snapshot.action.arguments).toEqual({
      command: 'echo KEEP_THIS_PENDING_ACTION',
    });
    expect(built.user).toContain('KEEP_THIS_PENDING_ACTION');
  });
});
