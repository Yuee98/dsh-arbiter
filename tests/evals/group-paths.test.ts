import { describe, expect, it } from 'vitest';
import type { Workflow } from '../../evals/src/data/group-types.js';
import { selectPointMaterial } from '../../evals/src/data/workflow-material.js';
import { workflow } from './fixtures/workflow.js';
import { loadWorkflow, problemText } from './helpers/grouped.js';

function branched(): Workflow {
  const root = workflow();
  return {
    ...root,
    branches: ['left', 'right'].map((branchId) => ({
      branchId,
      parentBranchId: 'main',
      fork: [{ sessionId: 'main', eventId: 'scan-result' }],
    })),
    events: [
      ...root.events.slice(0, 3),
      {
        eventId: 'left-call',
        branchId: 'left',
        sessionId: 'main',
        seq: 4,
        turnId: 't',
        kind: 'call',
        callId: 'candidate',
        tool: 'shell',
        arguments: 'rm build',
        route: 'reviewer',
      },
      {
        eventId: 'left-result',
        branchId: 'left',
        sessionId: 'main',
        seq: 5,
        turnId: 't',
        kind: 'result',
        callId: 'candidate',
        status: 'success',
        body: { state: 'present', content: 'LEFT_RESULT_SENTINEL' },
      },
      {
        eventId: 'left-next',
        branchId: 'left',
        sessionId: 'main',
        seq: 6,
        turnId: 't',
        kind: 'call',
        callId: 'next',
        tool: 'shell',
        arguments: 'build',
        route: 'reviewer',
      },
      {
        eventId: 'right-call',
        branchId: 'right',
        sessionId: 'main',
        seq: 4,
        turnId: 't',
        kind: 'call',
        callId: 'candidate',
        tool: 'shell',
        arguments: 'rm assets',
        route: 'reviewer',
      },
      {
        eventId: 'right-result',
        branchId: 'right',
        sessionId: 'main',
        seq: 5,
        turnId: 't',
        kind: 'result',
        callId: 'candidate',
        status: 'failure',
        body: { state: 'present', content: 'RIGHT_RESULT_SENTINEL' },
      },
      {
        eventId: 'right-next',
        branchId: 'right',
        sessionId: 'main',
        seq: 6,
        turnId: 't',
        kind: 'call',
        callId: 'next',
        tool: 'shell',
        arguments: 'stop',
        route: 'reviewer',
      },
    ],
    points: ['left', 'right'].map((branchId) => ({
      pointId: `${branchId}-point`,
      primaryViewId: `${branchId}-view`,
      sessionId: 'main',
      branchId,
      cutoffEventId: `${branchId}-result`,
      pending: { callEventId: `${branchId}-next` },
    })),
  };
}

describe('declared branch prefixes', () => {
  it('shares a real prefix, preserves native order and excludes mutually exclusive results', async () => {
    const root = branched();
    const loaded = await loadWorkflow(root);
    expect(loaded.problems).toEqual([]);
    const left = selectPointMaterial(loaded, root.rootId, 'left-point');
    expect(left.history.map((event) => event.seq)).toEqual([0, 2, 3, 4, 5]);
    expect(JSON.stringify(left)).toContain('LEFT_RESULT_SENTINEL');
    expect(JSON.stringify(left)).not.toContain('RIGHT_RESULT_SENTINEL');
    const right = selectPointMaterial(loaded, root.rootId, 'right-point');
    expect(JSON.stringify(right)).toContain('RIGHT_RESULT_SENTINEL');
    expect(JSON.stringify(right)).not.toContain('LEFT_RESULT_SENTINEL');
  });

  it('rejects cross-branch pending and cutoff references', async () => {
    const root = branched();
    const badPending = await loadWorkflow({
      ...root,
      points: [{ ...root.points[0], pending: { callEventId: 'right-next' } }],
    });
    expect(problemText(badPending)).toContain('not a call');
    const badCutoff = await loadWorkflow({
      ...root,
      points: [{ ...root.points[0], cutoffEventId: 'right-result' }],
    });
    expect(problemText(badCutoff)).toContain('not reachable');
  });

  it('rejects branch cycles, unknown forks and sequence reversal after a fork', async () => {
    const root = branched();
    const cycle = await loadWorkflow({
      ...root,
      branches: [{ branchId: 'left', parentBranchId: 'left', fork: [] }],
    });
    expect(problemText(cycle)).toContain('branch cycle');
    const fork = await loadWorkflow({
      ...root,
      branches: [
        {
          branchId: 'left',
          parentBranchId: 'main',
          fork: [{ sessionId: 'main', eventId: 'right-result' }],
        },
      ],
    });
    expect(problemText(fork)).toContain('not reachable');
    const order = await loadWorkflow({
      ...root,
      events: root.events.map((event) =>
        event.eventId === 'left-call' ? { ...event, seq: 1 } : event,
      ),
    });
    expect(problemText(order)).toContain('is not after');
  });

  it('does not backdate a late result into its earlier call', async () => {
    const root = workflow();
    const result = root.events.find((event) => event.eventId === 'scan-result');
    expect(result).toBeDefined();
    const events = root.events.filter(
      (event) => event.eventId !== 'scan-result',
    );
    const loaded = await loadWorkflow({
      ...root,
      events: [...events, { ...result, seq: 10 }],
      points: [
        { ...root.points[0], cutoffEventId: 'scan-call' },
        {
          ...root.points[2],
          cutoffEventId: 'scan-result',
          predecessorPointId: 'format-clean',
        },
      ],
    });
    expect(loaded.problems).toEqual([]);
    expect(
      selectPointMaterial(loaded, root.rootId, 'format-clean').history.map(
        (event) => event.eventId,
      ),
    ).toEqual(['request', 'scan-call']);
    expect(
      selectPointMaterial(loaded, root.rootId, 'format-repair').history.at(-1),
    ).toMatchObject({ eventId: 'scan-result', seq: 10 });
  });
});
