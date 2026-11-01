import { describe, expect, it } from 'vitest';
import type { Workflow } from '../../evals/src/data/group-types.js';
import { selectPointMaterial } from '../../evals/src/data/workflow-material.js';
import { collectionOf, workflow, childWorkflow } from './fixtures/workflow.js';
import { approvedTarget, VERSIONS } from './fixtures/documents.js';
import { loadWorkflow, problemText } from './helpers/grouped.js';

function settlement(
  outcome: 'allowed' | 'denied' | 'aborted',
  afterResult = false,
): Workflow {
  const root = workflow();
  const seq = afterResult ? 6 : 5;
  const events = root.events.map((event) =>
    event.seq >= seq ? { ...event, seq: event.seq + 1 } : event,
  );
  const index = events.findIndex((event) => event.seq > seq);
  events.splice(index, 0, {
    eventId: 'clean-settlement',
    sessionId: 'main',
    seq,
    turnId: 'turn-1',
    kind: 'settlement',
    callId: 'clean',
    outcome,
  });
  return { ...root, events };
}

function label(target: unknown): unknown {
  return {
    referenceId: 'ref',
    rootId: 'format-build',
    pointId: 'format-clean',
    viewId: 'format-clean-main',
    source: 'human',
    humanConfirmed: true,
    scoringEligible: true,
    versions: VERSIONS,
    batchId: 'batch',
    supportingOpinionIds: [],
    target,
  };
}

describe('review R1 regressions', () => {
  it('B01 rejects recorded-call cutoffs before the real immediate prefix or after the call', async () => {
    const root = workflow();
    const early = await loadWorkflow({
      ...root,
      points: [{ ...root.points[0], cutoffEventId: 'request' }],
    });
    expect(problemText(early)).toContain('recorded pending cutoff');
    const late = await loadWorkflow({
      ...root,
      events: root.events.filter((event) => event.eventId !== 'clean-result'),
      points: [{ ...root.points[0], cutoffEventId: 'ask-build' }],
    });
    expect(problemText(late)).toContain('recorded pending cutoff');
  });

  it('B02 rejects conflicting future records for an inline pending identity', async () => {
    const root = workflow();
    const pending = {
      callId: 'clean',
      tool: 'shell',
      arguments: { command: 'cat safe.txt' },
      route: 'reviewer',
    };
    const loaded = await loadWorkflow({
      ...root,
      points: [{ ...root.points[0], pending }],
    });
    expect(problemText(loaded)).toContain('inline pending disagrees');
  });

  it('B02 accepts an inline snapshot before a matching future call and compares JSON structurally', async () => {
    const root = workflow();
    const loaded = await loadWorkflow({
      ...root,
      events: root.events.map((event) =>
        event.eventId === 'clean-call'
          ? {
              ...event,
              arguments: { command: 'rm build', options: { b: 2, a: 1 } },
            }
          : event,
      ),
      points: [
        {
          ...root.points[0],
          pending: {
            callId: 'clean',
            tool: 'shell',
            arguments: { options: { a: 1, b: 2 }, command: 'rm build' },
            route: 'reviewer',
          },
        },
      ],
    });
    expect(loaded.problems).toEqual([]);
    expect(
      selectPointMaterial(loaded, root.rootId, 'format-clean').pending.callId,
    ).toBe('clean');
  });

  it.each([
    { tool: 'other-tool' },
    { cwd: '/different-workspace' },
    { route: 'bypass' },
  ])(
    'B02 verifies all action fields against later records: %j',
    async (patch) => {
      const root = workflow();
      const loaded = await loadWorkflow({
        ...root,
        events: root.events.map((event) =>
          event.eventId === 'clean-call' ? { ...event, ...patch } : event,
        ),
        points: [
          {
            ...root.points[0],
            pending: {
              callId: 'clean',
              tool: 'shell',
              arguments: { command: 'rm -rf build/' },
              route: 'reviewer',
            },
          },
        ],
      });
      expect(problemText(loaded)).toContain('inline pending disagrees');
    },
  );

  it('B03 rejects an inline predecessor from a mutually exclusive branch', async () => {
    const root = workflow();
    const loaded = await loadWorkflow({
      ...root,
      events: root.events.slice(0, 3),
      branches: ['left', 'right'].map((branchId) => ({
        branchId,
        parentBranchId: 'main',
        fork: [{ sessionId: 'main', eventId: 'scan-result' }],
      })),
      points: [
        {
          pointId: 'left-point',
          primaryViewId: 'left-view',
          sessionId: 'main',
          branchId: 'left',
          cutoffEventId: 'scan-result',
          pending: {
            callId: 'left',
            tool: 'shell',
            arguments: 'left',
            route: 'reviewer',
          },
        },
        {
          pointId: 'right-point',
          primaryViewId: 'right-view',
          sessionId: 'main',
          branchId: 'right',
          cutoffEventId: 'scan-result',
          pending: {
            callId: 'right',
            tool: 'shell',
            arguments: 'right',
            route: 'reviewer',
          },
          predecessorPointId: 'left-point',
        },
      ],
    });
    expect(problemText(loaded)).toContain(
      'predecessor branch is not an ancestor',
    );
  });

  it.each(['denied', 'aborted'] as const)(
    'B04 rejects execution after %s settlement',
    async (outcome) => {
      const loaded = await loadWorkflow(settlement(outcome));
      expect(problemText(loaded)).toContain(
        'blocked call cannot have an execution result',
      );
    },
  );

  it('B04 rejects a result preceding its recorded settlement and keeps allowed execution', async () => {
    const invalid = await loadWorkflow(settlement('allowed', true));
    expect(problemText(invalid)).toContain('result precedes settlement');
    const allowed = await loadWorkflow(settlement('allowed'));
    expect(allowed.problems).toEqual([]);
  });

  it('B04 retains absent/unreadable results and multiple actual result channels', async () => {
    const blocked = settlement('denied');
    const noResult = await loadWorkflow({
      ...blocked,
      events: blocked.events.filter(
        (event) => event.eventId !== 'clean-result',
      ),
    });
    expect(noResult.problems).toEqual([]);
    const root = settlement('allowed');
    const unreadable = await loadWorkflow({
      ...root,
      events: [
        ...root.events.map((event) =>
          event.eventId === 'clean-result'
            ? { ...event, body: { state: 'unavailable', reason: 'unreadable' } }
            : event,
        ),
        {
          eventId: 'extra-channel',
          sessionId: 'main',
          seq: 11,
          turnId: 'turn-2',
          kind: 'result',
          callId: 'clean',
          status: 'success',
          body: {
            state: 'present',
            content: { channel: 'stderr', text: 'warning' },
          },
        },
      ],
    });
    expect(unreadable.problems).toEqual([]);
  });

  it('B05 rejects relay without a direct parent and preserves a verified sender', async () => {
    const root = workflow();
    const invalid = await loadWorkflow({
      ...root,
      events: root.events.map((event) =>
        event.eventId === 'request'
          ? { ...event, source: 'parent-relay' }
          : event,
      ),
    });
    expect(problemText(invalid)).toContain('relay requires a direct parent');
    const child = childWorkflow();
    const good = await loadWorkflow({
      ...child,
      events: child.events.map((event) =>
        event.kind === 'message' && event.source === 'parent-relay'
          ? { ...event, senderSessionId: 'parent' }
          : event,
      ),
    });
    expect(good.problems).toEqual([]);
    expect(
      selectPointMaterial(good, child.rootId, 'child-first-point').history[0],
    ).toMatchObject({ senderSessionId: 'parent' });
    const wrong = await loadWorkflow({
      ...child,
      events: child.events.map((event) =>
        event.kind === 'message' && event.source === 'parent-relay'
          ? { ...event, senderSessionId: 'sibling' }
          : event,
      ),
    });
    expect(problemText(wrong)).toContain(
      'relay sender must be the direct parent',
    );
  });

  it('B06 rejects impossible pairs, missing explicit pairs and mixed prohibition sets', async () => {
    for (const [target, message] of [
      [approvedTarget({ allowedPairs: [[1, 1]] }), 'outside the allowed sets'],
      [
        approvedTarget({ allowed: { risk: [7, 8], authorization: [9] } }),
        'enumerate allowedPairs',
      ],
      [
        approvedTarget({
          allowed: { risk: [7], authorization: [1, 9] },
          allowedPairs: [
            [7, 1],
            [7, 9],
          ],
        }),
        'authorization combines band 1',
      ],
    ] as const) {
      const loaded = await loadWorkflow(workflow(), {
        'dev/f01/labels.json': collectionOf(label(target)),
      });
      expect(problemText(loaded)).toContain(message);
    }
  });

  it('B06 keeps independent expected behaviour independent from the current matrix', async () => {
    const loaded = await loadWorkflow(workflow(), {
      'dev/f01/labels.json': collectionOf(
        label(approvedTarget({ behaviourReference: 'deny' })),
      ),
    });
    expect(loaded.problems).toEqual([]);
  });
});
