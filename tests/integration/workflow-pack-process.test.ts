/** Cross-process credential normalization on synthetic material only. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, expect, test } from 'vitest';
const home = await mkdtemp(join(tmpdir(), 'pack-process-home-'));
process.env['DSH_HOME'] = home;
const { withDataset, REPOSITORY_ROOT } =
  await import('../evals/helpers/dataset.js');
const { collectionOf, workflow } =
  await import('../evals/fixtures/workflow.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test('prepared credential markers survive actual CLI process boundaries without raw secret disclosure', async () => {
  await withDataset(async (f) => {
    const directory = await realpath(f.path);
    const source = workflow(),
      point = source.points[0];
    if (point === undefined) throw new Error('fixture');
    await f.write(
      'data/dev/f01/workflows.json',
      collectionOf({
        ...source,
        events: source.events.map((event) =>
          event.kind === 'message' && event.eventId === 'request'
            ? {
                ...event,
                content: `${event.content} password=synthetic-pack-source-secret`,
              }
            : event,
        ),
      }),
    );
    await f.write('selection.json', [
      {
        group: 'f01',
        rootId: source.rootId,
        pointId: point.pointId,
        viewId: point.primaryViewId,
      },
    ]);
    await f.write('context.json', DEFAULT_ANNOTATION_CONTEXT);
    const cli = join(REPOSITORY_ROOT, 'evals/src/cli.ts'),
      run = promisify(execFile);
    await run(
      process.execPath,
      [
        cli,
        'workflow-prepare',
        join(directory, 'data'),
        '--selection',
        join(directory, 'selection.json'),
        '--context',
        join(directory, 'context.json'),
        '--out',
        join(directory, 'pack'),
      ],
      { cwd: REPOSITORY_ROOT, env: process.env },
    );
    const baseline = join(directory, 'pack/private/f01.json');
    const batch = await readWorkflowBatch(baseline),
      question = batch.points[0]?.questionId;
    if (question === undefined) throw new Error('fixture');
    expect(JSON.stringify(batch)).not.toContain('synthetic-pack-source-secret');
    expect(batch.points[0]?.binding?.credentials).toBe(true);
    const task = join(directory, 'task');
    const created = await run(
      process.execPath,
      [
        cli,
        'workflow-task',
        join(directory, 'data'),
        '--batch',
        baseline,
        '--question',
        question,
        '--attempt',
        'separate-process',
        '--out',
        task,
      ],
      { cwd: REPOSITORY_ROOT, env: process.env },
    );
    expect(created.stdout).toContain('"modelKey":null');
    const text = await readFile(join(task, 'question.json'), 'utf8');
    expect(text).not.toContain('synthetic-pack-source-secret');
    expect(text).toContain('[redacted:v1:');
  });
}, 30000);
