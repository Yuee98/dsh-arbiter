/** End-to-end CLI against synthetic temporary datasets; no external annotation. */
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
const home = await mkdtemp('/private/tmp/pack-collection-home-');
process.env['DSH_HOME'] = home;
const { withDataset } = await import('../evals/helpers/dataset.js');
const { collectionOf, workflow } =
  await import('../evals/fixtures/workflow.js');
const { models, answer } =
  await import('../evals/helpers/workflow-annotation.js');
const { runWorkflowAnnotationCli } =
  await import('../../evals/src/annotation/workflow-command.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { workflowReferences } =
  await import('../../evals/src/annotation/workflow-service.js');
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test('CLI preserves failed/raw attempts, separates preview and write, and counts one model once', async () => {
  await withDataset(async (f) => {
    const fixture = workflow(),
      selected = fixture.points[0];
    if (selected === undefined) throw new Error('fixture');
    await f.write('data/dev/f01/workflows.json', collectionOf(fixture));
    await f.write('selection.json', [
      {
        group: 'f01',
        rootId: fixture.rootId,
        pointId: selected.pointId,
        viewId: selected.primaryViewId,
      },
    ]);
    await f.write('models.json', models(1));
    await f.write('context.json', DEFAULT_ANNOTATION_CONTEXT);
    const outputs: string[] = [],
      errors: string[] = [];
    const cli = async (args: readonly string[]) => {
      outputs.length = 0;
      errors.length = 0;
      return runWorkflowAnnotationCli(args, {
        root: f.path,
        out: (line) => outputs.push(line),
        err: (line) => errors.push(line),
      });
    };
    expect(
      await cli([
        'workflow-prepare',
        'data',
        '--selection',
        'selection.json',
        '--context',
        'context.json',
        '--out',
        'pack',
      ]),
    ).toBe(0);
    const prepared = join(f.path, 'pack/private/f01.json');
    const neutral = await readWorkflowBatch(prepared);
    const question = neutral.points[0]?.questionId;
    if (question === undefined) throw new Error('question');
    const registered = join(f.path, 'pack/private/registered/models.json');
    const register = [
      'workflow-register',
      'data',
      '--prepared',
      prepared,
      '--models',
      'models.json',
      '--out',
      registered,
    ];
    expect(await cli(register)).toBe(0);
    expect(await readdir(join(f.path, 'data/dev/f01'))).toEqual([
      'workflows.json',
    ]);
    expect(await cli([...register, '--write'])).toBe(0);
    const batch = await readWorkflowBatch(registered);
    expect(batch.models).toHaveLength(1);
    for (const [index, raw] of [
      '{ broken synthetic JSON',
      JSON.stringify(answer()),
      JSON.stringify(answer({ pairs: [[4, 9]] })),
    ].entries()) {
      const taskDir = join(f.path, `attempt-${String(index)}`);
      expect(
        await cli([
          'workflow-task',
          'data',
          '--batch',
          registered,
          '--question',
          question,
          '--model',
          'synthetic-0',
          '--attempt',
          `attempt-${String(index)}`,
          '--out',
          taskDir,
        ]),
      ).toBe(0);
      const receipt = /"receipt":"([^"]+)"/u.exec(outputs[0] ?? '')?.[1];
      if (receipt === undefined) throw new Error('receipt');
      await writeFile(join(taskDir, 'answer.txt'), raw, { flag: 'wx' });
      const before = await readFile(
        join(f.path, 'data/dev/f01/opinions.json'),
        'utf8',
      );
      const collect = [
        'workflow-collect',
        'data',
        '--batch',
        registered,
        '--receipt',
        receipt,
      ];
      expect(await cli(collect)).toBe(0);
      expect(
        await readFile(join(f.path, 'data/dev/f01/opinions.json'), 'utf8'),
      ).toBe(before);
      expect(await cli([...collect, '--write'])).toBe(0);
      expect(await cli([...collect, '--write'])).toBe(0);
      const retained = await readFile(
        receipt.replace(/\.json$/u, '.return.json'),
        'utf8',
      );
      expect(JSON.parse(retained) as unknown).toMatchObject({
        rawResponse: raw,
      });
    }
    const reference = await workflowReferences({
      root: f.path,
      dataset: neutral.dataset,
      split: 'dev',
      group: 'f01',
      context: DEFAULT_ANNOTATION_CONTEXT,
    });
    expect(reference.entries[0]?.consensus?.n).toBe(1);
    expect(reference.entries[0]?.consensus?.valid).toBe(1);
    expect(reference.entries[0]?.humanConfirmed).toBe(false);
    // A missing file is an operator read error; only an explicit no-return records missing.
    expect(
      await cli([
        'workflow-task',
        'data',
        '--batch',
        registered,
        '--question',
        question,
        '--model',
        'synthetic-0',
        '--attempt',
        'missing',
        '--out',
        'missing-task',
      ]),
    ).toBe(0);
    const missingReceipt = /"receipt":"([^"]+)"/u.exec(outputs[0] ?? '')?.[1];
    if (missingReceipt === undefined) throw new Error('receipt');
    const missing = [
      'workflow-collect',
      'data',
      '--batch',
      registered,
      '--receipt',
      missingReceipt,
    ];
    expect(await cli(missing)).toBe(1);
    const namesBefore = await readdir(dirname(missingReceipt));
    expect(namesBefore).not.toContain(
      missingReceipt.split('/').at(-1)?.replace('.json', '.return.json'),
    );
    expect(await cli([...missing, '--missing'])).toBe(0);
    expect(await cli([...missing, '--missing', '--write'])).toBe(0);
    expect(
      await cli([
        'workflow-task',
        'data',
        '--batch',
        registered,
        '--question',
        question,
        '--model',
        'synthetic-0',
        '--attempt',
        'provider-error',
        '--out',
        'error-task',
      ]),
    ).toBe(0);
    const errorReceipt = /"receipt":"([^"]+)"/u.exec(outputs[0] ?? '')?.[1];
    if (errorReceipt === undefined) throw new Error('receipt');
    expect(
      await cli([
        'workflow-collect',
        'data',
        '--batch',
        registered,
        '--receipt',
        errorReceipt,
        '--error',
        'Synthetic reported provider failure',
        '--write',
      ]),
    ).toBe(0);
    const saved = await readWorkflowBatch(registered);
    expect(
      saved.opinions.some(
        (opinion) =>
          opinion.annotation?.rawResponse === '{ broken synthetic JSON',
      ),
    ).toBe(true);
    expect(
      saved.opinions.filter((opinion) => opinion.annotation?.complete),
    ).toHaveLength(2);
  });
}, 30000);
