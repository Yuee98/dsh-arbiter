import { describe, expect, it } from 'vitest';
import type { Workflow } from '../../evals/src/data/group-types.js';
import { workflow } from './fixtures/workflow.js';
import { loadWorkflow, problemText } from './helpers/grouped.js';

function parentPredecessor(recorded = false, forkAtCall = false): Workflow {
  return workflow({
    sessions: [
      { sessionId: 'parent' },
      { sessionId: 'child', parentSessionId: 'parent' },
    ],
    branches: [
      {
        branchId: 'fork',
        parentBranchId: 'main',
        fork: [
          {
            sessionId: 'parent',
            eventId: forkAtCall ? 'parent-call' : 'parent-initial',
          },
        ],
      },
    ],
    events: [
      {
        eventId: 'parent-initial',
        sessionId: 'parent',
        seq: 1,
        turnId: null,
        kind: 'message',
        role: 'user',
        source: 'human',
        content: 'initial instruction',
      },
      {
        eventId: 'parent-call',
        sessionId: 'parent',
        seq: 2,
        turnId: null,
        kind: 'call',
        callId: 'parent-logged',
        tool: 'shell',
        arguments: 'prepare',
        route: 'reviewer',
      },
      {
        eventId: 'parent-later',
        sessionId: 'parent',
        seq: 3,
        turnId: null,
        kind: 'message',
        role: 'user',
        source: 'human',
        content: 'not inherited by fork',
      },
      {
        eventId: 'child-initial',
        sessionId: 'child',
        seq: 1,
        turnId: null,
        branchId: 'fork',
        kind: 'message',
        role: 'user',
        source: 'parent-relay',
        senderSessionId: 'parent',
        content: 'delegated scope',
      },
    ],
    points: [
      {
        pointId: 'parent-point',
        primaryViewId: 'parent-view',
        sessionId: 'parent',
        cutoffEventId: recorded ? 'parent-initial' : 'parent-later',
        pending: recorded
          ? { callEventId: 'parent-call' }
          : {
              callId: 'parent-inline',
              tool: 'shell',
              arguments: 'next',
              route: 'reviewer',
            },
      },
      {
        pointId: 'child-point',
        primaryViewId: 'child-view',
        sessionId: 'child',
        branchId: 'fork',
        cutoffEventId: 'child-initial',
        pending: {
          callId: 'child-inline',
          tool: 'shell',
          arguments: 'child-next',
          route: 'reviewer',
        },
        parentRead: {
          sessionId: 'parent',
          cutoffEventId: 'parent-initial',
          status: 'complete',
        },
        predecessorPointId: 'parent-point',
      },
    ],
  });
}

describe('R2 continuation and terminal identity boundaries', () => {
  it('rejects an ancestor inline predecessor whose own cutoff is outside the fork across sessions', async () => {
    const loaded = await loadWorkflow(parentPredecessor());
    expect(problemText(loaded)).toContain(
      'cutoff parent-later is not reachable',
    );
  });

  it('allows a real fork-before cross-session predecessor without comparing unrelated seq values', async () => {
    const root = parentPredecessor();
    const loaded = await loadWorkflow({
      ...root,
      points: root.points.map((point) =>
        point.pointId === 'parent-point'
          ? { ...point, cutoffEventId: 'parent-initial' }
          : point,
      ),
    });
    expect(loaded.problems).toEqual([]);
  });

  it('requires a predecessor recorded call to remain reachable, independently of its cutoff', async () => {
    expect(problemText(await loadWorkflow(parentPredecessor(true)))).toContain(
      'predecessor call is not reachable',
    );
    expect(
      (await loadWorkflow(parentPredecessor(true, true))).problems,
    ).toEqual([]);
  });

  it('checks the predecessor parent-read footprint as well as its own cutoff', async () => {
    const root = parentPredecessor();
    const loaded = await loadWorkflow({
      ...root,
      sessions: [
        { sessionId: 'grandparent' },
        { sessionId: 'parent', parentSessionId: 'grandparent' },
        { sessionId: 'child', parentSessionId: 'parent' },
      ],
      events: [
        {
          eventId: 'grandparent-initial',
          sessionId: 'grandparent',
          seq: 1,
          turnId: null,
          kind: 'message',
          role: 'user',
          source: 'human',
          content: 'initial',
        },
        {
          eventId: 'grandparent-later',
          sessionId: 'grandparent',
          seq: 2,
          turnId: null,
          kind: 'message',
          role: 'user',
          source: 'human',
          content: 'not inherited',
        },
        ...root.events,
      ],
      branches: [
        {
          branchId: 'fork',
          parentBranchId: 'main',
          fork: [
            { sessionId: 'parent', eventId: 'parent-initial' },
            { sessionId: 'grandparent', eventId: 'grandparent-initial' },
          ],
        },
      ],
      points: root.points.map((point) =>
        point.pointId === 'parent-point'
          ? {
              ...point,
              cutoffEventId: 'parent-initial',
              parentRead: {
                sessionId: 'grandparent',
                cutoffEventId: 'grandparent-later',
                status: 'complete',
              },
            }
          : point,
      ),
    });
    expect(problemText(loaded)).toContain(
      'cutoff grandparent-later is not reachable',
    );
  });

  it.each([
    ['allowed', 'denied'],
    ['denied', 'allowed'],
    ['allowed', 'allowed'],
  ] as const)(
    'rejects a second terminal settlement %s -> %s even without results',
    async (first, second) => {
      const root = workflow();
      const events = root.events
        .filter((event) => event.eventId !== 'clean-result')
        .map((event) =>
          event.seq >= 5 ? { ...event, seq: event.seq + 2 } : event,
        );
      const index = events.findIndex((event) => event.seq > 5);
      events.splice(
        index,
        0,
        {
          eventId: 'settle-first',
          sessionId: 'main',
          seq: 5,
          turnId: null,
          kind: 'settlement',
          callId: 'clean',
          outcome: first,
        },
        {
          eventId: 'settle-second',
          sessionId: 'main',
          seq: 6,
          turnId: null,
          kind: 'settlement',
          callId: 'clean',
          outcome: second,
        },
      );
      expect(problemText(await loadWorkflow({ ...root, events }))).toContain(
        'duplicate terminal settlement',
      );
    },
  );
});
