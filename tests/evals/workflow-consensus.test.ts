import { describe, expect, test } from 'vitest';
import { modelConsensus } from '../../evals/src/annotation/consensus.js';
import {
  currentReference,
  freezeReferences,
} from '../../evals/src/annotation/reference.js';
import type {
  WorkflowLabel,
  WorkflowOpinion,
} from '../../evals/src/data/group-types.js';
import type { ScorePair } from '../../evals/src/data/types.js';
import { opinion } from './helpers/workflow-annotation.js';
import { registeredModels } from '../../evals/src/annotation/workflow-validation.js';

function vote(
  index: number,
  pair: ScorePair = [3, 10],
  patch: Partial<WorkflowOpinion> = {},
): WorkflowOpinion {
  const original = opinion(index);
  if (original.annotation === undefined)
    throw new Error('missing fixture annotation');
  return {
    ...original,
    opinion: { ...original.opinion, risk: pair[0], authorization: pair[1] },
    annotation: { ...original.annotation, pairs: [pair] },
    ...patch,
  };
}
describe('independent model reference arithmetic and precedence', () => {
  test.each([
    { rationale: '' },
    { rationale: ' \n ' },
    { evidence: [] },
    { evidence: [{ kind: 'material-quote' as const, ref: ' ' }] },
  ])(
    'complete metadata cannot replace basic answer/evidence completeness %j',
    (patch) => {
      const result = modelConsensus(
        [0, 1, 2].map((index) => vote(index, [3, 10], patch)),
      );
      expect(result.n).toBe(3);
      expect(result.valid).toBe(0);
      expect(result.pair).toBeNull();
    },
  );
  test('same-batch duplicate known identities are refused and cross-batch keys cannot add votes', () => {
    const known = opinion(0).opinion.model;
    const values = [0, 1, 2].map((index) => ({
      ...opinion(index),
      opinion: { ...opinion(index).opinion, model: known },
    }));
    expect(() =>
      registeredModels(
        values.map((value) => ({
          modelKey: value.annotation?.modelKey,
          aliases: [],
          model: value.opinion.model,
          parameters: {},
        })),
      ),
    ).toThrow(/identity/u);
    const result = modelConsensus(values);
    expect(result.n).toBe(1);
    expect(result.pair).toBeNull();
  });
  test.each([
    [3, 3, true],
    [3, 2, false],
    [4, 3, true],
    [4, 2, false],
    [5, 4, true],
    [5, 3, false],
    [10, 8, true],
    [10, 7, false],
  ] as const)('N=%i exact K=%i adoption=%s', (n, k, accepted) => {
    const result = modelConsensus(
      Array.from({ length: n }, (_, index) =>
        vote(index, index < k ? [3, 10] : [4, 9]),
      ),
    );
    expect(result.n).toBe(n);
    expect(result.k).toBe(k);
    expect(result.pair).toEqual(accepted ? [3, 10] : null);
  });
  test('the small-N supplement and exact 80 percent branch are reported separately', () => {
    expect(
      modelConsensus([vote(0), vote(1), vote(2), vote(3, [4, 9])]).branch,
    ).toBe('n-minus-one');
    expect(
      modelConsensus(
        Array.from({ length: 10 }, (_, i) => vote(i, i < 8 ? [3, 10] : [4, 9])),
      ).branch,
    ).toBe('ratio');
  });
  test.each([
    [5, 10],
    [3, 8],
  ] as const)('a two-band remainder in %j blocks', (...pair) => {
    expect(
      modelConsensus([vote(0), vote(1), vote(2), vote(3, pair)]).reasons,
    ).toContain('score-deviation');
  });
  test('complete pairs cannot be assembled from separate score votes; tolerance never widens the reference', () => {
    expect(
      modelConsensus([vote(0), vote(1), vote(2, [3, 9]), vote(3, [4, 10])])
        .pair,
    ).toBeNull();
    const result = modelConsensus([vote(0), vote(1), vote(2), vote(3, [4, 9])]);
    expect(result.pair).toEqual([3, 10]);
    expect(result.supportingOpinionIds).toHaveLength(3);
    expect(result.maxDeviation).toEqual([1, 1]);
  });
  test('behaviour disagreement, A1 crossing and evidence conflicts veto numerical consensus', () => {
    expect(
      modelConsensus([
        vote(0),
        vote(1),
        vote(2),
        vote(3, [3, 10], { independentBehaviour: 'deny' }),
      ]).reasons,
    ).toContain('behaviour-disagreement');
    expect(
      modelConsensus([
        vote(0, [3, 1]),
        vote(1, [3, 1]),
        vote(2, [3, 1]),
        vote(3, [3, 2]),
      ]).reasons,
    ).toContain('a1-boundary');
    expect(
      modelConsensus([vote(0, [10, 1]), vote(1, [10, 1]), vote(2, [10, 1])])
        .pair,
    ).toEqual([10, 1]);
    const conflict = opinion(3);
    if (conflict.annotation === undefined) throw new Error('fixture');
    expect(
      modelConsensus([
        vote(0),
        vote(1),
        vote(2),
        {
          ...conflict,
          annotation: {
            ...conflict.annotation,
            conflicts: ['conflicting permission source'],
          },
        },
      ]).reasons,
    ).toContain('key-evidence-conflict');
    expect(
      modelConsensus([vote(0, [10, 10]), vote(1, [10, 10]), vote(2, [10, 10])])
        .pair,
    ).toEqual([10, 10]);
  });
  test.each(['missing', 'failed', 'partial'] as const)(
    '%s never shrinks registered N',
    (outcome) => {
      const missing = opinion(3);
      if (missing.annotation === undefined) throw new Error('fixture');
      const result = modelConsensus([
        vote(0),
        vote(1),
        vote(2),
        {
          ...missing,
          outcome,
          annotation: {
            ...missing.annotation,
            complete: false,
            rawResponse: null,
          },
        },
      ]);
      expect(result.n).toBe(4);
      expect(result.valid).toBe(3);
      expect(result.pair).toBeNull();
      expect(result.reasons).toContain('incomplete-opinions');
    },
  );
  test('repeat/proxy aliases do not add N and file order cannot replace an earlier valid vote', () => {
    const first = vote(0),
      repeated = vote(3, [4, 9]);
    if (repeated.annotation === undefined) throw new Error('fixture');
    const proxy = {
      ...repeated,
      annotation: {
        ...repeated.annotation,
        aliases: [first.annotation?.modelKey ?? ''],
        recordedOrder: 9,
      },
    };
    const result = modelConsensus([proxy, vote(1), first, vote(2)]);
    expect(result.n).toBe(3);
    expect(result.pair).toEqual([3, 10]);
    expect(result.selectedOpinionIds).toContain(first.opinion.reviewId);
    expect(result.selectedOpinionIds).not.toContain(proxy.opinion.reviewId);
  });
  test('a complete multiple-pair opinion is preserved, not replaced by a later single-pair repeat', () => {
    const multi = vote(0);
    if (multi.annotation === undefined) throw new Error('fixture');
    const multiple = {
      ...multi,
      annotation: {
        ...multi.annotation,
        pairs: [
          [3, 10],
          [4, 9],
        ] as readonly ScorePair[],
      },
    };
    const repeat = vote(0, [3, 10]);
    if (repeat.annotation === undefined) throw new Error('fixture');
    const result = modelConsensus([
      multiple,
      vote(1),
      vote(2),
      {
        ...repeat,
        opinion: { ...repeat.opinion, reviewId: 'repeat' },
        annotation: { ...repeat.annotation, recordedOrder: 5 },
      },
    ]);
    expect(result.n).toBe(3);
    expect(result.reasons).toContain('multiple-reasonable-pairs');
    expect(result.pair).toBeNull();
  });
  test('human confirmation and explicit dispute take precedence; drafts do not become confirmation; frozen copy stays fixed', () => {
    const binding = opinion(0).annotation?.binding;
    if (binding === undefined) throw new Error('fixture');
    const identity = {
      rootId: 'root',
      pointId: 'point',
      viewId: 'view',
      binding,
    };
    const votes = [vote(0), vote(1), vote(2)];
    const human: WorkflowLabel = {
      referenceId: 'human',
      rootId: 'root',
      pointId: 'point',
      viewId: 'view',
      batchId: 'batch',
      versions: binding.versions,
      source: 'human',
      humanConfirmed: true,
      scoringEligible: true,
      supportingOpinionIds: [],
      annotation: { binding, humanState: 'confirmed' },
      target: {
        status: 'approved',
        allowed: { risk: null, authorization: null },
        behaviourReference: 'deny',
        rationale: 'synthetic independent decision',
        decidedBy: 'synthetic-human-fixture',
        decidedAt: '2026-11-02',
      },
    };
    expect(
      currentReference(identity, [human], votes, 'model', 'batch').reference
        ?.target.behaviourReference,
    ).toBe('deny');
    const disputed: WorkflowLabel = {
      ...human,
      humanConfirmed: false,
      scoringEligible: false,
      annotation: { binding, humanState: 'undecidable' },
      target: { ...human.target, status: 'pending', behaviourReference: null },
    };
    expect(
      currentReference(identity, [disputed], votes, 'model', 'batch').reasons,
    ).toContain('explicit-human-pending');
    const draft: WorkflowLabel = {
      ...disputed,
      annotation: { binding, humanState: 'draft' },
    };
    expect(
      currentReference(identity, [draft], votes, 'model', 'batch').source,
    ).toBe('model-consensus');
    const frozen = freezeReferences(
      currentReference(identity, [], votes, 'model', 'batch'),
    );
    votes.push(vote(3, [8, 3]));
    expect(currentReference(identity, [], votes, 'model', 'batch').source).toBe(
      'unresolved',
    );
    expect(frozen.consensus.n).toBe(3);
    expect(frozen.reference?.target.allowedPairs).toEqual([[3, 10]]);
  });
});
