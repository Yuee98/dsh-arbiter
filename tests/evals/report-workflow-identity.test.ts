import { describe, expect, it } from 'vitest';
import { trajectorySection } from '../../evals/src/metrics/trajectories.js';
import { relationSection } from '../../evals/src/metrics/relations.js';
import { qualitySection } from '../../evals/src/metrics/quality.js';
import { stabilitySection } from '../../evals/src/metrics/stability.js';
import { monotonicityStats } from '../../evals/src/metrics/diagnostics.js';
import type { WorkflowMetricSource } from '../../evals/src/metrics/workflow-metrics-types.js';
import type { MetricSource } from '../../evals/src/metrics/source.js';
import {
  metricCell,
  metricReference,
  scored,
} from './helpers/quality-cells.js';

const settings = { mode: 'ask', channel: 'available' } as const;
const source: WorkflowMetricSource = {
  group: 'f01',
  split: 'dev',
  path: 'synthetic-declarations-only',
  workflow: {
    rootId: 'root-a',
    points: [
      {
        pointId: 'p1',
        primaryViewId: 'p1-view',
        sessionId: 'main',
        cutoffEventId: null,
        pending: {
          callId: 'one',
          tool: 'shell',
          arguments: {},
          route: 'reviewer',
        },
      },
      {
        pointId: 'p2',
        primaryViewId: 'p2-view',
        sessionId: 'main',
        cutoffEventId: null,
        predecessorPointId: 'p1',
        pending: {
          callId: 'two',
          tool: 'shell',
          arguments: {},
          route: 'reviewer',
        },
      },
    ],
    relations: [
      {
        relationId: 'pair',
        kind: 'controlled',
        pointIds: ['p1', 'p2'],
        description: 'Free text does not define the tested invariant.',
      },
    ],
  },
};
function identity(
  pointId: string,
  patch: Partial<Extract<MetricSource, { kind: 'workflow' }>> = {},
): MetricSource {
  return {
    kind: 'workflow',
    rootId: 'root-a',
    lineageId: 'lineage-a',
    pointId,
    viewId: `${pointId}-view`,
    group: 'f01',
    split: 'dev',
    branchId: 'main',
    primaryView: true,
    ...patch,
  };
}
const referenceA = () =>
  metricReference('allow', 'human', {
    allowed: { risk: [3], authorization: [10] },
  });
const referenceB = () =>
  metricReference('allow', 'human', {
    allowed: { risk: [7], authorization: [10] },
  });

describe('workflow metric identities and declared fixed paths', () => {
  it('counts roots, lineages, points and views separately from repeat/target and legacy compatibility keys', () => {
    const cells = [
      metricCell('compat', { source: identity('p1') }),
      metricCell('compat', {
        source: identity('p1', { viewId: 'diagnostic', primaryView: false }),
      }),
      metricCell('compat', { source: identity('p2') }),
      metricCell('compat', { source: identity('p1', { rootId: 'root-b' }) }),
      metricCell('compat', { source: identity('p1'), repeat: 2 }),
      metricCell('compat', { source: identity('p1'), target: 'target-b' }),
      metricCell('compat', { source: { kind: 'legacy', caseId: 'compat' } }),
    ];
    expect(qualitySection(cells, settings).identities).toMatchObject({
      legacyCases: 1,
      roots: 2,
      lineages: 1,
      points: 3,
      views: 4,
      primaryViews: 3,
      diagnosticViews: 1,
      repeatCells: 1,
    });
    expect(qualitySection(cells, settings).overall.conditions.cells).toBe(6);
    expect(stabilitySection(cells).repeatGroups).toHaveLength(1);
    expect(stabilitySection(cells).repeatGroups[0]).toMatchObject({
      repeats: 2,
      judged: 2,
    });
    expect(
      qualitySection(cells, settings).byGroup.find(
        (group) => group.axis === 'content-set' && group.key === 'legacy-v1',
      )?.population.cells.cells,
    ).toBe(1);
  });
  it('reports complete agreement, first observed deviation, missing planned nodes and partial scope separately', () => {
    const p1 = metricCell('p1', { reference: referenceA() });
    const p2 = metricCell('p2', {
      outcome: scored(7, 10),
      reference: referenceB(),
    });
    expect(trajectorySection([p1, p2], [source])).toMatchObject({
      selected: 1,
      completeScope: 1,
      assessable: 1,
      satisfied: 1,
      actualContinuation: 'not-observed',
    });
    const wrong = metricCell('p2', {
      outcome: scored(7, 1),
      reference: referenceB(),
    });
    expect(trajectorySection([p1, wrong], [source]).rows[0]).toMatchObject({
      status: 'violated',
      firstObservedDeviation: 'p2',
      firstUnassessable: null,
    });
    const missing = metricCell('p2', {
      missing: true,
      reference: referenceB(),
    });
    expect(trajectorySection([p1, missing], [source])).toMatchObject({
      selected: 1,
      assessable: 0,
      incomplete: 1,
      agreement: { numerator: 0, denominator: 0, rate: null },
    });
    expect(
      trajectorySection([p1, missing], [source]).rows[0]?.firstUnassessable,
    ).toBe('p2');
    expect(trajectorySection([p1], [source])).toMatchObject({
      partialScope: 1,
      completeScope: 0,
      assessable: 0,
    });
    expect(
      trajectorySection(
        [p1, p2],
        [
          {
            ...source,
            workflow: {
              ...source.workflow,
              points: source.workflow.points.map(
                ({ predecessorPointId: _predecessor, ...point }) => point,
              ),
            },
          },
        ],
      ).selected,
    ).toBe(0);
  });
  it('keeps the main terminal when an unselected branch continues from it', () => {
    const previous = source.workflow.points.at(-1);
    if (previous === undefined) throw new Error('missing declaration');
    const branched: WorkflowMetricSource = {
      ...source,
      workflow: {
        ...source.workflow,
        points: [
          ...source.workflow.points,
          {
            ...previous,
            pointId: 'p3',
            primaryViewId: 'p3-view',
            branchId: 'alternate',
            predecessorPointId: 'p2',
          },
        ],
      },
    };
    const main = [metricCell('p1'), metricCell('p2')];
    expect(trajectorySection(main, [branched])).toMatchObject({
      selected: 1,
      satisfied: 1,
      rows: [{ branchId: 'main', terminalPointId: 'p2' }],
    });
    const alternate = metricCell('p3', {
      source: identity('p3', { branchId: 'alternate' }),
    });
    const result = trajectorySection([...main, alternate], [branched]);
    expect(result).toMatchObject({
      selected: 2,
      satisfied: 2,
      partialScope: 0,
    });
    expect(result.rows.map((row) => [row.branchId, row.nodes.length])).toEqual([
      ['main', 2],
      ['alternate', 3],
    ]);
    expect(trajectorySection([alternate], [branched])).toMatchObject({
      selected: 1,
      partialScope: 1,
      assessable: 0,
    });
  });

  it('does not mix targets, repeat conditions or diagnostic views into a fixed primary trajectory', () => {
    const cells = [
      metricCell('p1'),
      metricCell('p2', { target: 'other' }),
      metricCell('p2', { repeat: 2 }),
      metricCell('p2', {
        source: identity('p2', { viewId: 'diagnostic', primaryView: false }),
      }),
    ];
    expect(trajectorySection(cells, [source])).toMatchObject({
      selected: 3,
      assessable: 0,
      partialScope: 3,
    });
  });
  it('counts relation-level satisfied, violated, unassessable and exact violation magnitudes', () => {
    const satisfied = [
      metricCell('p1', { reference: referenceA() }),
      metricCell('p2', { outcome: scored(7, 10), reference: referenceB() }),
    ];
    const violated = [
      metricCell('p1', {
        outcome: scored(7, 10),
        repeat: 2,
        reference: referenceA(),
      }),
      metricCell('p2', {
        outcome: scored(3, 10),
        repeat: 2,
        reference: referenceB(),
      }),
    ];
    const ambiguous = [
      metricCell('p1', {
        repeat: 3,
        reference: metricReference('allow', 'human', {
          allowed: { risk: [3, 4], authorization: [10] },
          allowedPairs: [
            [3, 10],
            [4, 10],
          ],
        }),
      }),
      metricCell('p2', {
        repeat: 3,
        outcome: scored(7, 10),
        reference: referenceB(),
      }),
    ];
    const result = relationSection(
      [...satisfied, ...violated, ...ambiguous],
      [source],
    );
    expect(result).toMatchObject({
      selected: 3,
      determinate: 2,
      satisfied: 1,
      violated: 1,
      unassessable: 1,
      agreement: { numerator: 1, denominator: 2, rate: 0.5 },
      fields: {
        risk: {
          planned: 3,
          assessable: 2,
          satisfied: 1,
          violated: 1,
          unassessable: 1,
        },
        authorization: {
          planned: 3,
          assessable: 3,
          satisfied: 3,
          violated: 0,
          unassessable: 0,
        },
      },
    });
    expect(result.rows[1]?.fields[0]).toMatchObject({
      expectedDelta: 4,
      observedDelta: -4,
      status: 'violated',
      violationMagnitude: 4,
    });
    expect(result.rows[2]?.fields[0]).toMatchObject({
      expectedDelta: null,
      status: 'unassessable',
      violationMagnitude: null,
    });
    expect(
      monotonicityStats([...satisfied, ...violated], 'risk'),
    ).toMatchObject({ comparablePairs: 1, reversals: 0 });
    const invariant = relationSection(
      [
        metricCell('p1', { outcome: scored(3, 9), reference: referenceA() }),
        satisfied[1] ?? metricCell('p2'),
      ],
      [source],
    );
    expect(invariant.rows[0]?.fields[1]).toMatchObject({
      expectedDelta: 0,
      observedDelta: 1,
      status: 'violated',
      violationMagnitude: 1,
    });
    const natural: WorkflowMetricSource = {
      ...source,
      workflow: {
        ...source.workflow,
        relations: [
          {
            relationId: 'natural',
            kind: 'natural',
            pointIds: ['p1', 'p2'],
            description: 'must not become a new invariant',
          },
        ],
      },
    };
    expect(relationSection(violated, [natural])).toMatchObject({
      descriptive: 1,
      determinate: 0,
      violated: 0,
    });
  });
});
