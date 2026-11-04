import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workflowReferences } from '../../evals/src/annotation/workflow-service.js';
import { DEFAULT_ANNOTATION_CONTEXT } from '../../evals/src/annotation/workflow-view.js';
import {
  frozenReferenceFor,
  readReferenceSnapshot,
} from '../../evals/src/metrics/reference-snapshot.js';
import type { ReferenceSnapshot } from '../../evals/src/metrics/reference-snapshot.js';
import type { WorkflowLabel } from '../../evals/src/data/group-types.js';
import { temporaryDataset } from './helpers/dataset.js';
import type { TemporaryDataset } from './helpers/dataset.js';
import { collectionOf, workflow } from './fixtures/workflow.js';
import { approvedTarget } from './fixtures/documents.js';

async function withSnapshot(
  body: (
    snapshot: ReferenceSnapshot,
    dataset: TemporaryDataset,
  ) => Promise<void> | void,
): Promise<void> {
  const dataset = await temporaryDataset();
  try {
    await dataset.write('dev/f01/workflows.json', collectionOf(workflow()));
    const exported = await workflowReferences({
      root: dataset.path,
      dataset: dataset.path,
      split: 'dev',
      group: 'f01',
      context: DEFAULT_ANNOTATION_CONTEXT,
    });
    await dataset.write('original.json', exported);
    const snapshot = await readReferenceSnapshot(
      join(dataset.path, 'original.json'),
    );
    const first = snapshot.entries[0];
    if (first?.binding === undefined || first.binding === null)
      throw new Error('synthetic material failed to build');
    const label: WorkflowLabel = {
      rootId: first.rootId,
      pointId: first.pointId,
      viewId: first.viewId,
      referenceId: 'synthetic-human',
      source: 'human',
      humanConfirmed: true,
      scoringEligible: true,
      versions: first.binding.versions,
      batchId: 'synthetic',
      supportingOpinionIds: [],
      target: approvedTarget({
        allowed: { risk: [3], authorization: [10] },
        behaviourReference: 'deny',
      }),
      annotation: { binding: first.binding, humanState: 'confirmed' },
    };
    const selected: ReferenceSnapshot = {
      ...snapshot,
      entries: [
        {
          ...first,
          source: 'human',
          reasons: [],
          humanConfirmed: true,
          scoringEligible: true,
          reference: label,
        },
        ...snapshot.entries.slice(1),
      ],
    };
    await body(selected, dataset);
  } finally {
    await dataset.remove();
  }
}
function selection(snapshot: ReferenceSnapshot) {
  const first = snapshot.entries[0];
  if (first === undefined) throw new Error('missing synthetic point');
  return {
    snapshots: [snapshot],
    rootId: first.rootId,
    pointId: first.pointId,
    viewId: first.viewId,
    split: 'dev',
    group: 'f01',
    protocol: snapshot.context.protocol,
    binding: first.binding,
  };
}

describe('existing frozen workflow reference snapshots', () => {
  it('reads the real #127 output shape and keeps an independent adverse behaviour', async () => {
    await withSnapshot(async (snapshot, dataset) => {
      await dataset.write('snapshot.json', snapshot);
      const read = await readReferenceSnapshot(
        join(dataset.path, 'snapshot.json'),
      );
      const reference = frozenReferenceFor(selection(read));
      expect(reference).toMatchObject({
        source: 'human',
        humanConfirmed: true,
        behaviourEligible: true,
        scoringEligible: true,
        target: {
          behaviourReference: 'deny',
          allowed: { risk: [3], authorization: [10] },
        },
      });
      const entry = snapshot.entries[0];
      if (entry?.reference === undefined || entry.reference === null)
        throw new Error('missing human fixture');
      const changed: ReferenceSnapshot = {
        ...snapshot,
        entries: [
          {
            ...entry,
            reference: {
              ...entry.reference,
              target: {
                ...entry.reference.target,
                behaviourReference: 'allow',
              },
            },
          },
        ],
      };
      expect(
        frozenReferenceFor(selection(changed)).target?.behaviourReference,
      ).toBe('allow');
      expect(reference.target?.behaviourReference).toBe('deny');
    });
  });
  it('uses sameAnnotationView semantics rather than equating source and rendered-request hashes', async () => {
    await withSnapshot((snapshot) => {
      const selected = selection(snapshot),
        binding = selected.binding;
      if (binding === null) throw new Error('missing binding');
      expect(
        frozenReferenceFor({
          ...selected,
          binding: { ...binding, inputHash: 'equivalent-source-reordered' },
        }).source,
      ).toBe('human');
      expect(
        frozenReferenceFor({
          ...selected,
          binding: { ...binding, promptFingerprint: 'different-budget-view' },
        }),
      ).toMatchObject({
        source: 'unresolved' as const,
        reasons: ['input-view-version-drift'],
        behaviourEligible: false,
      });
      expect(
        frozenReferenceFor({
          ...selected,
          binding: {
            ...binding,
            credentials: true,
            inputHash: 'credential-value-changed',
          },
        }).source,
      ).toBe('unresolved');
      expect(
        frozenReferenceFor({
          ...selected,
          binding: {
            ...binding,
            versions: { ...binding.versions, rubric: 'changed' },
          },
        }).source,
      ).toBe('unresolved');
      expect(
        frozenReferenceFor({ ...selected, binding: null }).reasons,
      ).toEqual(['run-view-unverified']);
      expect(
        frozenReferenceFor({ ...selected, rootId: 'other-root' }).reasons,
      ).toEqual(['frozen-reference-missing']);
      expect(
        frozenReferenceFor({ ...selected, viewId: 'other-view' }).source,
      ).toBe('unresolved');
      expect(
        frozenReferenceFor({ ...selected, group: 'other-group' }).source,
      ).toBe('unresolved');
      expect(
        frozenReferenceFor({ ...selected, protocol: 'decision' }).source,
      ).toBe('unresolved');
      expect(() =>
        frozenReferenceFor({ ...selected, snapshots: [snapshot, snapshot] }),
      ).toThrow('ambiguous frozen reference');
    });
  });
  it('keeps provisional machine references separate and never falls back around a saved human veto', async () => {
    await withSnapshot(async (snapshot, dataset) => {
      const first = snapshot.entries[0];
      if (first?.reference === undefined || first.reference === null)
        throw new Error('missing reference');
      const binding = first.binding;
      if (binding === null) throw new Error('missing binding');
      const machine = {
        ...first,
        source: 'model-consensus',
        humanConfirmed: false,
        consensus:
          first.consensus === null
            ? null
            : {
                ...first.consensus,
                n: 3,
                k: 3,
                returned: 3,
                valid: 3,
                missing: 0,
                failed: 0,
                pair: [3, 10] as const,
                behaviour: 'deny' as const,
                branch: 'ratio' as const,
                maxDeviation: [0, 0] as const,
              },
        reference: {
          ...first.reference,
          source: 'model-consensus' as const,
          humanConfirmed: false,
          target: { ...first.reference.target, status: 'pending' as const },
          annotation: { binding },
        },
      };
      const modelSnapshot = { ...snapshot, entries: [machine] };
      await dataset.write('model.json', modelSnapshot);
      const read = await readReferenceSnapshot(
        join(dataset.path, 'model.json'),
      );
      expect(frozenReferenceFor(selection(read))).toMatchObject({
        source: 'model-consensus',
        humanConfirmed: false,
        scoringEligible: true,
        target: { status: 'pending' },
      });
      const pending = {
        ...first,
        source: 'unresolved' as const,
        humanConfirmed: false,
        scoringEligible: false,
        reference: null,
        reasons: ['explicit-human-pending'],
      };
      const veto = { ...snapshot, entries: [pending] };
      expect(frozenReferenceFor(selection(veto))).toMatchObject({
        source: 'unresolved',
        behaviourEligible: false,
        scoringEligible: false,
        reasons: ['explicit-human-pending'],
      });
    });
  });
  it('rejects duplicate identities, invalid score structure, false human flags and private batch fields', async () => {
    await withSnapshot(async (snapshot, dataset) => {
      const first = snapshot.entries[0];
      if (first?.reference === undefined || first.reference === null)
        throw new Error('missing reference');
      const variants = [
        { ...snapshot, entries: [first, first] },
        {
          ...snapshot,
          entries: [
            {
              ...first,
              source: 'model-consensus',
              reference: { ...first.reference, source: 'model-consensus' },
            },
          ],
        },
        {
          ...snapshot,
          entries: [
            {
              ...first,
              reference: {
                ...first.reference,
                target: {
                  ...first.reference.target,
                  allowed: { risk: [3], authorization: [1, 10] },
                  allowedPairs: [
                    [3, 1],
                    [3, 10],
                  ],
                },
              },
            },
          ],
        },
        {
          ...snapshot,
          entries: [
            {
              ...first,
              reference: {
                ...first.reference,
                target: { ...first.reference.target, allowedPairs: [[2, 10]] },
              },
            },
          ],
        },
        { ...snapshot, retryKey: 'private-sentinel' },
      ];
      for (const [index, value] of variants.entries()) {
        await dataset.write(`invalid-${String(index)}.json`, value);
        await expect(
          readReferenceSnapshot(
            join(dataset.path, `invalid-${String(index)}.json`),
          ),
        ).rejects.toThrow();
      }
    });
  });
});
