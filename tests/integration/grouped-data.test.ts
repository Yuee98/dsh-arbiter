import { readFile, writeFile, mkdir, symlink, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { loadDefinition } from '../../evals/src/experiments/load.js';
import { readGroupedDataset } from '../../evals/src/data/group-read.js';
import { selectPointMaterial } from '../../evals/src/data/workflow-material.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';
import {
  manifest,
  reviewCase,
  reviewLabel,
  caseReviews,
  input,
} from '../evals/fixtures/documents.js';
import { withDataset, REPOSITORY_ROOT } from '../evals/helpers/dataset.js';
import type { TemporaryDataset } from '../evals/helpers/dataset.js';
import { problemText } from '../evals/helpers/grouped.js';

const cli = join(REPOSITORY_ROOT, 'evals/src/cli.ts');

function command(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

/** Exercise the same command router in a child with an isolated repository root. */
function all(root: string): ReturnType<typeof spawnSync> {
  const register = pathToFileURL(
    join(REPOSITORY_ROOT, 'evals/src/cli/register.ts'),
  ).href;
  const grouped = pathToFileURL(
    join(REPOSITORY_ROOT, 'evals/src/data/group-command.ts'),
  ).href;
  const legacy = pathToFileURL(
    join(REPOSITORY_ROOT, 'evals/src/cli/run.ts'),
  ).href;
  const source = `import ${JSON.stringify(register)}; const {runGroupedCli}=await import(${JSON.stringify(grouped)}); const {runCli}=await import(${JSON.stringify(legacy)}); const io={root:${JSON.stringify(root)},out:console.log,err:console.error}; process.exitCode=await runGroupedCli(['check-all'],io,runCli);`;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { cwd: root, encoding: 'utf8', timeout: 15_000 },
  );
}

async function authority(dataset: TemporaryDataset): Promise<void> {
  for (const relative of [
    'evals/rubrics/rubric-v1.json',
    'docs/milestones/review-quality-rubrics.md',
  ]) {
    await mkdir(join(dataset.path, relative, '..'), { recursive: true });
    await writeFile(
      join(dataset.path, relative),
      await readFile(join(REPOSITORY_ROOT, relative)),
    );
  }
  // A real existing experiment remains checked, with its old source outside the
  // published directory so the grouped-only regression stays grouped-only.
  await cp(
    join(REPOSITORY_ROOT, 'evals/datasets/core-v1'),
    join(dataset.path, '.local/experiment-source'),
    { recursive: true },
  );
  const loaded = await loadDefinition(
    join(REPOSITORY_ROOT, 'evals/experiments/rq14-matrix.json'),
  );
  if (!loaded.ok) throw new Error(loaded.problems.join('; '));
  await dataset.write('evals/experiments/rq14-matrix.json', {
    ...loaded.definition,
    dataset: {
      ...loaded.definition.dataset,
      datasetPath: '.local/experiment-source',
    },
  });
}

function otherRoot(id: string): unknown {
  const root = workflow();
  return {
    ...root,
    rootId: id,
    points: root.points.map((point) => ({
      ...point,
      pointId: `${id}-${point.pointId}`,
      primaryViewId: `${id}-${point.primaryViewId}`,
      ...(point.predecessorPointId === undefined
        ? {}
        : { predecessorPointId: `${id}-${point.predecessorPointId}` }),
    })),
  };
}

describe('grouped filesystem scope', () => {
  it('physically avoids invalid unselected groups, holdout, answers and authoring', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('dev/f01/workflows.json', collectionOf(workflow()));
      for (const path of [
        'holdout/f01/workflows.json',
        'dev/f02/workflows.json',
        'dev/f01/labels.json',
        'dev/f01/opinions.json',
        'dev/f01/authoring.json',
      ]) {
        await mkdir(join(dataset.path, path, '..'), { recursive: true });
        await writeFile(join(dataset.path, path), '{ invalid JSON');
      }
      const selected = await readGroupedDataset(dataset.path, { group: 'f01' });
      expect(selected.problems).toEqual([]);
      expect(selected.groups).toHaveLength(1);
      expect(selected.groups[0]?.labels).toEqual([]);
      expect(
        selectPointMaterial(selected, 'format-build', 'format-clean').pending
          .callId,
      ).toBe('clean');
      const allSelected = await readGroupedDataset(dataset.path, {
        split: 'all',
        references: true,
      });
      expect(problemText(allSelected)).toContain('holdout/f01/workflows.json#');
      expect(problemText(allSelected)).toContain('dev/f01/labels.json#');
      expect(problemText(allSelected)).not.toContain('authoring.json');
    });
  });

  it('rejects missing scope, path traversal, mixed sources and symlink files', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('dev/f01/workflows.json', collectionOf(workflow()));
      expect(
        problemText(
          await readGroupedDataset(dataset.path, { group: 'missing' }),
        ),
      ).toContain('does not exist');
      expect(
        problemText(
          await readGroupedDataset(dataset.path, { group: '../holdout' }),
        ),
      ).toContain('invalid split/group');
      await dataset.write('dev/f01/cases.json', collectionOf(reviewCase()));
      expect(problemText(await readGroupedDataset(dataset.path))).toContain(
        'sources cannot be mixed',
      );
      await mkdir(join(dataset.path, 'dev/f03'), { recursive: true });
      await symlink(
        join(dataset.path, 'dev/f01/workflows.json'),
        join(dataset.path, 'dev/f03/workflows.json'),
      );
      expect(
        problemText(await readGroupedDataset(dataset.path, { group: 'f03' })),
      ).toContain('symlinks are not followed');
    });
  });

  it('keeps stable identities after record reordering and rejects symlink scopes', async () => {
    await withDataset(async (dataset) => {
      await dataset.write(
        'dev/f01/workflows.json',
        collectionOf(workflow(), otherRoot('independent')),
      );
      const before = await readGroupedDataset(dataset.path);
      await dataset.write(
        'dev/f01/workflows.json',
        collectionOf(otherRoot('independent'), workflow()),
      );
      const after = await readGroupedDataset(dataset.path);
      expect(after.problems).toEqual([]);
      expect(
        selectPointMaterial(after, 'format-build', 'format-clean'),
      ).toEqual(selectPointMaterial(before, 'format-build', 'format-clean'));
      await symlink(
        join(dataset.path, 'dev/f01'),
        join(dataset.path, 'dev/linked'),
      );
      expect(problemText(await readGroupedDataset(dataset.path))).toContain(
        'selected group directory',
      );
      await symlink(join(dataset.path, 'dev'), join(dataset.path, 'holdout'));
      expect(
        problemText(
          await readGroupedDataset(dataset.path, {
            split: 'all',
            group: 'f01',
          }),
        ),
      ).toContain('selected split directory');
    });
  });

  it('reports global duplicate IDs and hard lineage/source conflicts only in the selected scope', async () => {
    await withDataset(async (dataset) => {
      await dataset.write(
        'dev/f01/workflows.json',
        collectionOf({ ...workflow(), lineageId: 'shared' }),
      );
      await dataset.write(
        'holdout/f01/workflows.json',
        collectionOf({ ...workflow(), lineageId: 'shared' }),
      );
      expect((await readGroupedDataset(dataset.path)).problems).toEqual([]);
      const global = await readGroupedDataset(dataset.path, { split: 'all' });
      expect(problemText(global)).toContain(
        'root format-build is also declared',
      );
      expect(problemText(global)).toContain(
        'point format-clean is also declared',
      );
      expect(problemText(global)).toContain(
        'view format-clean-main is also declared',
      );
      expect(problemText(global)).toContain('lineage shared crosses splits');
    });
  });

  it('does not treat equal free-text origin as proof of common source', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('dev/f01/workflows.json', collectionOf(workflow()));
      await dataset.write(
        'holdout/f01/workflows.json',
        collectionOf(otherRoot('independent')),
      );
      const checked = await readGroupedDataset(dataset.path, { split: 'all' });
      expect(checked.problems).toEqual([]);
      expect(checked.findings[0]?.message).toContain(
        'description alone is not identity',
      );
      const source = {
        ...workflow().provenance,
        sourceId: 'actual-common-source',
      };
      await dataset.write(
        'dev/f01/workflows.json',
        collectionOf({ ...workflow(), provenance: source }),
      );
      await dataset.write(
        'holdout/f01/workflows.json',
        collectionOf({ ...workflow(), rootId: 'another', provenance: source }),
      );
      expect(
        problemText(await readGroupedDataset(dataset.path, { split: 'all' })),
      ).toContain('source actual-common-source crosses splits');
    });
  });

  it('preserves legacy fields and old hash/coherence checks in collections', async () => {
    await withDataset(async (dataset) => {
      const hash = inputHashOf(input());
      await dataset.write(
        'dev/legacy-v1/cases.json',
        collectionOf(reviewCase()),
      );
      await dataset.write(
        'dev/legacy-v1/labels.json',
        collectionOf(reviewLabel(hash)),
      );
      await dataset.write(
        'dev/legacy-v1/opinions.json',
        collectionOf(caseReviews(hash)),
      );
      const checked = await readGroupedDataset(dataset.path, {
        references: true,
        contentSet: 'legacy-v1',
      });
      expect(checked.problems).toEqual([]);
      expect(checked.groups[0]?.cases[0]?.document).toEqual(reviewCase());
      expect(checked.groups[0]?.labels[0]?.document).toEqual(reviewLabel(hash));
      expect(checked.groups[0]?.opinions[0]?.document).toEqual(
        caseReviews(hash),
      );
      await dataset.write(
        'dev/legacy-v1/labels.json',
        collectionOf(reviewLabel(`sha256:${'0'.repeat(64)}`)),
      );
      expect(
        problemText(
          await readGroupedDataset(dataset.path, { references: true }),
        ),
      ).toContain('input-changed');
      await dataset.write(
        'calibration/legacy-v1/cases.json',
        collectionOf(reviewCase({ caseId: 'case-b', split: 'calibration' })),
      );
      expect(
        problemText(await readGroupedDataset(dataset.path, { split: 'all' })),
      ).toContain('lineage fam-a crosses splits');
    });
  });
});

describe('real CLI and check-all registration', () => {
  it('checks new and old fixtures with explicit format and scope, without writes', () => {
    const legacy = command(['check', 'evals/datasets/format-example']);
    expect(legacy.status).toBe(0);
    expect(String(legacy.stdout)).toContain('2 cases');
    const grouped = command([
      'check',
      'evals/datasets/format-example',
      '--format',
      'grouped-v1',
      '--group',
      'f01-build-cleanup',
    ]);
    expect(grouped.status).toBe(0);
    expect(String(grouped.stdout)).toContain('scope dev/f01-build-cleanup');
    expect(String(grouped.stdout)).toContain('1 roots, 3 points');
  });

  it('exits nonzero for invalid version, route and options through the actual entry', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('dev/f01/workflows.json', {
        schemaVersion: 'future',
        records: [workflow()],
      });
      const version = command([
        'check',
        dataset.path,
        '--format',
        'grouped-v1',
      ]);
      expect(version.status).toBe(1);
      expect(String(version.stderr)).toContain('schemaVersion');
      const root = workflow();
      await dataset.write(
        'dev/f01/workflows.json',
        collectionOf({
          ...root,
          points: [
            { ...root.points[0], pending: { callEventId: 'scan-call' } },
          ],
        }),
      );
      const route = command(['check', dataset.path, '--format', 'grouped-v1']);
      expect(route.status).toBe(1);
      expect(String(route.stderr)).toContain('reviewer call');
      const flag = command([
        'check',
        dataset.path,
        '--format',
        'grouped-v1',
        '--split',
        'train',
      ]);
      expect(flag.status).toBe(2);
    });
  });

  it('never skips a broken legacy manifest beside a valid grouped dataset', async () => {
    await withDataset(async (dataset) => {
      await authority(dataset);
      await dataset.write('evals/datasets/old/cases/case-a.json', reviewCase());
      await dataset.write(
        'evals/datasets/new/dev/f01/workflows.json',
        collectionOf(workflow()),
      );
      const result = all(dataset.path);
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain('manifest.json');
      expect(String(result.stdout)).toContain('1 roots, 3 points');
    });
  });

  it('checks rubric even when every published dataset is grouped', async () => {
    await withDataset(async (dataset) => {
      await authority(dataset);
      await dataset.write(
        'evals/datasets/new/dev/f01/workflows.json',
        collectionOf(workflow()),
      );
      expect(all(dataset.path).status).toBe(0);
      const rubricPath = join(dataset.path, 'evals/rubrics/rubric-v1.json');
      const rubric: unknown = JSON.parse(await readFile(rubricPath, 'utf8'));
      await dataset.write('evals/rubrics/rubric-v1.json', {
        ...(typeof rubric === 'object' && rubric !== null ? rubric : {}),
        contractVersion: 'obsolete-contract',
      });
      const result = all(dataset.path);
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain('rubric');
      expect(String(result.stdout)).toContain('1 roots, 3 points');
    });
  });

  it('keeps invalid old single documents rejected and checks both layouts in one dataset', async () => {
    await withDataset(async (dataset) => {
      await authority(dataset);
      await dataset.write('evals/datasets/mixed/cases/case-a.json', {
        ...reviewCase(),
        expectedRisk: 10,
      });
      await dataset.write(
        'evals/datasets/mixed/manifest.json',
        manifest(['case-a']),
      );
      await dataset.write(
        'evals/datasets/mixed/dev/f01/workflows.json',
        collectionOf(workflow()),
      );
      const result = all(dataset.path);
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain('expectedRisk');
      expect(String(result.stdout)).toContain('1 roots, 3 points');
    });
  });
});
