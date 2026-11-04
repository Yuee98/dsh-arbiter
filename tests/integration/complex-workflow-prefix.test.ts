/** The committed source must expose completed business effects only after their calls. */
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, configHash } from '../../src/config.js';
import { readGroupedDataset } from '../../evals/src/data/group-read.js';
import { workflowMaterial } from '../../evals/src/run/material.js';
import { buildAnnotationView } from '../../evals/src/annotation/workflow-view.js';

const dataset = await readGroupedDataset(
  fileURLToPath(new URL('../../evals/datasets/reviewer-v2', import.meta.url)),
  { split: 'dev', contentSet: 'workflows-v1', references: false },
);
const config = {
  ...DEFAULT_CONFIG,
  context: {
    ...DEFAULT_CONFIG.context,
    projectRules: { ...DEFAULT_CONFIG.context.projectRules, enabled: false },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Inspect the JSON actually shown in the wire payload, excluding human plans/action. */
function observedResults(request: unknown): Record<string, unknown>[] {
  if (!record(request)) throw new Error('missing production request');
  const text = request['user'] ?? request['state'];
  if (typeof text !== 'string') throw new Error('missing wire material');
  const block = text
    .split('\nSESSION_TIMELINE\n')[1]
    ?.split('\n\nPRIOR_VERDICTS\n')[0];
  if (block === undefined) throw new Error('missing visible timeline');
  const timeline: unknown = JSON.parse(block.slice(block.indexOf('\n{') + 1));
  if (!record(timeline) || !Array.isArray(timeline['events']))
    throw new Error('invalid visible timeline');
  return timeline['events'].filter(
    (event): event is Record<string, unknown> =>
      record(event) && event['kind'] === 'result',
  );
}

/** Decode structured/JSON stdout observations; explicit previews are not completed effects. */
function observedObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(observedObjects);
  if (record(value)) {
    if (value['mode'] === 'preview-only' || value['mode'] === 'hypothetical')
      return [];
    return [value, ...Object.values(value).flatMap(observedObjects)];
  }
  if (typeof value === 'string')
    return value.split('\n').flatMap((line) => {
      try {
        return observedObjects(JSON.parse(line) as unknown);
      } catch {
        return [];
      }
    });
  return [];
}

const cases = [
  {
    rootId: 'cw135-009',
    signal: 'probe after-rotation aggregate',
    firstPoint: null,
    tool: null,
    completed: (row: Record<string, unknown>) => {
      const after = row['after'];
      return record(after) && after['old'] === 401 && after['current'] === 200;
    },
  },
  {
    rootId: 'cw135-009',
    signal: 'new credential authenticated',
    firstPoint: 'cw135-009-p03',
    tool: 'http.request',
    completed: (row: Record<string, unknown>) => row['authenticated'] === true,
  },
  {
    rootId: 'cw135-009',
    signal: 'old credential rejected',
    firstPoint: 'cw135-009-p05',
    tool: 'http.request',
    completed: (row: Record<string, unknown>) => row['authenticated'] === false,
  },
  {
    rootId: 'cw135-011',
    signal: 'restore matches source',
    firstPoint: 'cw135-011-p04',
    tool: 'database.restoreVerify',
    completed: (row: Record<string, unknown>) => row['matchesSource'] === true,
  },
  {
    rootId: 'cw135-012',
    signal: 'transaction rolled back',
    firstPoint: 'cw135-012-p04',
    tool: 'database.transaction',
    completed: (row: Record<string, unknown>) =>
      row['rolledBack'] === true || row['failedTransactionRolledBack'] === true,
  },
  {
    rootId: 'cw135-020',
    signal: 'current region is r2',
    firstPoint: 'cw135-020-p02',
    tool: 'storage.migrate',
    completed: (row: Record<string, unknown>) => row['region'] === 'r2',
  },
  {
    rootId: 'cw135-023',
    signal: 'files compacted',
    firstPoint: 'cw135-023-p04',
    tool: 'maintenance.run',
    completed: (row: Record<string, unknown>) =>
      typeof row['compactedFiles'] === 'number' && row['compactedFiles'] > 0,
  },
  {
    rootId: 'cw135-024',
    signal: 'disabled scope narrowed',
    firstPoint: 'cw135-024-p05',
    tool: 'scheduler.update',
    completed: (row: Record<string, unknown>) =>
      row['enabled'] === false &&
      Array.isArray(row['scope']) &&
      row['scope'].includes('tmp/job-8/cache'),
  },
] as const;

describe.each(['chat', 'decision'] as const)(
  '%s completed workflow effects',
  (protocol) => {
    test.each(cases)(
      '$rootId exposes $signal first at $firstPoint',
      async ({ rootId, completed, firstPoint, tool }) => {
        expect(dataset.problems).toEqual([]);
        const root = dataset.groups
          .flatMap((group) => group.workflows)
          .find((entry) => entry.document.rootId === rootId)?.document;
        if (root === undefined) throw new Error(`missing source ${rootId}`);
        const seen: { pointId: string; result: Record<string, unknown> }[] = [];
        for (const point of root.points) {
          const material = await workflowMaterial(
            dataset,
            rootId,
            point.pointId,
            protocol,
            { config, configRevision: configHash(config), projectRules: null },
          );
          const annotation = await buildAnnotationView(
            dataset,
            rootId,
            point.pointId,
            {
              protocol,
              targetInputTokens: 6000,
              maxInputTokens: 10000,
              customRules: '',
              projectRulesEnabled: false,
              projectRules: null,
            },
          );
          expect(annotation.request).toEqual(material.request);
          for (const result of observedResults(material.request)) {
            if (observedObjects(result['body']).some(completed))
              seen.push({ pointId: point.pointId, result });
          }
        }
        expect(seen[0]?.pointId ?? null).toBe(firstPoint);
        const call = seen[0]?.result['call'];
        expect(record(call) ? call['tool'] : null).toBe(tool);
      },
    );
  },
);
