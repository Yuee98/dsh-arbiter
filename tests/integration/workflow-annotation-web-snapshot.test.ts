import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';
import { withDataset } from '../evals/helpers/dataset.js';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const isolatedHome = await fs.mkdtemp(join(tmpdir(), 'arbiter-web-snapshot-'));
process.env['DSH_HOME'] = isolatedHome;
const { AnnotationWorkspace } =
  await import('../../evals/src/annotation/web-workspace.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
afterAll(async () => {
  await fs.rm(isolatedHome, { recursive: true, force: true });
});

test('each bootstrap reads a group once for all points and the next request reads current files again', async () => {
  await withDataset(async (f) => {
    const path = join(f.path, 'data/dev/f01/workflows.json');
    await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
    await f.write('data/dev/f01/labels.json', collectionOf());
    const workspace = await AnnotationWorkspace.open({
      root: f.path,
      dataset: join(f.path, 'data'),
      split: 'dev',
      group: 'f01',
      mode: 'blind',
      context: DEFAULT_ANNOTATION_CONTEXT,
    });
    vi.mocked(fs.readFile).mockClear();
    const first = await workspace.bootstrap();
    expect(first.points).toHaveLength(3);
    expect(
      vi.mocked(fs.readFile).mock.calls.filter(([file]) => file === path),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter(
          ([file]) => file === join(f.path, 'data/dev/f01/labels.json'),
        ),
    ).toHaveLength(1);
    await fs.writeFile(path, 'invalid source changed between requests');
    await expect(workspace.bootstrap()).rejects.toThrow();
  });
}, 30_000);
