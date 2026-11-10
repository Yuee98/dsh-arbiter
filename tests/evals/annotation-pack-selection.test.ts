import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, test } from 'vitest';
const home = await mkdtemp(join(tmpdir(), 'pack-selection-home-'));
process.env['DSH_HOME'] = home;
const { packSelection, selectedSources } =
  await import('../../evals/src/annotation/pack-selection.js');
const { REPOSITORY_ROOT } = await import('./helpers/dataset.js');
const { buildAnnotationView } =
  await import('../../evals/src/annotation/workflow-view.js');
const { annotationContext } =
  await import('../../evals/src/annotation/workflow-view.js');
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
async function config(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'evals/plans', name), 'utf8'),
  ) as unknown;
}
describe('actual pilot/remainder selections', () => {
  test('exact historical pilot identities partition all 117 actual production points', async () => {
    const pilot = packSelection(await config('cw-136-pilot-points.json'));
    const rest = packSelection(await config('cw-136-remainder-points.json'));
    const original: unknown = await config('cw-134-first-four.json');
    if (
      typeof original !== 'object' ||
      original === null ||
      !('workflow' in original) ||
      typeof original.workflow !== 'object' ||
      original.workflow === null ||
      !('points' in original.workflow)
    )
      throw new Error('plan fixture');
    expect(pilot).toEqual(original.workflow.points);
    expect(pilot).toHaveLength(20);
    expect(rest).toHaveLength(97);
    expect(new Set(pilot.map((p) => p.rootId)).size).toBe(4);
    const key = (p: (typeof pilot)[number]) => JSON.stringify(p);
    const identities = new Set([...pilot, ...rest].map(key));
    expect(identities.size).toBe(117);
    const dataset = join(REPOSITORY_ROOT, 'evals/datasets/reviewer-v2');
    const sources = await selectedSources(dataset, 'dev', [...pilot, ...rest]);
    const actual = [...sources.entries()].flatMap(([group, source]) =>
      source.groups.flatMap((g) =>
        g.workflows.flatMap((w) =>
          w.document.points.map((p) => ({
            group,
            rootId: w.document.rootId,
            pointId: p.pointId,
            viewId: p.primaryViewId,
          })),
        ),
      ),
    );
    expect(new Set(actual.map(key))).toEqual(identities);
    const context = annotationContext(
      await config('cw-136-annotation-context.json'),
    );
    for (const point of pilot) {
      const source = sources.get(point.group);
      if (source === undefined) throw new Error('source');
      const view = await buildAnnotationView(
        source,
        point.rootId,
        point.pointId,
        context,
      );
      expect(view.binding.promptFingerprint).not.toBe('');
      expect(view.request).not.toBeNull();
    }
    await expect(selectedSources(dataset, 'holdout', pilot)).rejects.toThrow();
    await expect(
      selectedSources(dataset, 'dev', [
        {
          ...pilot[0],
          group: 'f01-build-cleanup',
          rootId: 'missing',
          pointId: 'missing',
          viewId: 'missing',
        },
      ]),
    ).rejects.toThrow();
  }, 30000);
  test.each(
    [
      [],
      [{ group: 'f01', rootId: 'a', pointId: 'p', viewId: 'v', split: 'dev' }],
      [{ group: '../f01', rootId: 'a', pointId: 'p', viewId: 'v' }],
    ].map((value) => ({ value })),
  )('rejects invalid selector $value', ({ value }) => {
    expect(() => packSelection(value)).toThrow();
  });
  test('duplicate point cannot be smuggled in under another view', () => {
    const first = { group: 'f01', rootId: 'a', pointId: 'p', viewId: 'v' };
    expect(() => packSelection([first, { ...first, viewId: 'other' }])).toThrow(
      /duplicate/u,
    );
  });
});
