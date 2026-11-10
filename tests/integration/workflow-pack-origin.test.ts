/** Synthetic offline returns only; no provider or human opinions. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, expect, test } from 'vitest';
const home = await mkdtemp(join(tmpdir(), 'pack-origin-home-'));
process.env['DSH_HOME'] = home;
const { withDataset } = await import('../evals/helpers/dataset.js');
const { collectionOf, workflow } =
  await import('../evals/fixtures/workflow.js');
const { models, answer } =
  await import('../evals/helpers/workflow-annotation.js');
const { prepareWorkflowPack } =
  await import('../../evals/src/annotation/pack-prepare.js');
const { registerPreparedPack } =
  await import('../../evals/src/annotation/pack-register.js');
const { createPackTask } =
  await import('../../evals/src/annotation/pack-task.js');
const { collectPackTask } =
  await import('../../evals/src/annotation/pack-collect.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { workflowReferences } =
  await import('../../evals/src/annotation/workflow-service.js');
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function withPack(
  body: (f: {
    root: string;
    dataset: string;
    baseline: string;
    ordinary: string;
    question: string;
  }) => Promise<void>,
) {
  await withDataset(async (f) => {
    const source = workflow(),
      point = source.points[0];
    if (point === undefined) throw new Error('fixture');
    await f.write('data/dev/f01/workflows.json', collectionOf(source));
    const pack = await prepareWorkflowPack({
      root: f.path,
      dataset: join(f.path, 'data'),
      split: 'dev',
      selection: [
        {
          group: 'f01',
          rootId: source.rootId,
          pointId: point.pointId,
          viewId: point.primaryViewId,
        },
      ],
      context: DEFAULT_ANNOTATION_CONTEXT,
      out: 'pack',
    });
    const baseline = pack.batches[0]?.baseline;
    if (baseline === undefined) throw new Error('baseline');
    const batch = await readWorkflowBatch(baseline),
      question = batch.points[0]?.questionId;
    if (question === undefined) throw new Error('question');
    const ordinary = join(f.path, 'pack/private/registered/actual.json');
    await registerPreparedPack({
      root: f.path,
      dataset: batch.dataset,
      prepared: baseline,
      models: models(3),
      out: ordinary,
      write: true,
    });
    await body({
      root: f.path,
      dataset: batch.dataset,
      baseline,
      ordinary,
      question,
    });
  });
}

test('missing, reported failure and returned answer remain distinct in persisted opinions and consensus', async () => {
  await withPack(async (f) => {
    for (const [index, state] of ['missing', 'failed', 'returned'].entries()) {
      const task = await createPackTask({
        ...f,
        batch: f.ordinary,
        model: `synthetic-${String(index)}`,
        attempt: state,
        out: state,
        channel: 'file',
      });
      if (state === 'returned')
        await writeFile(task.result, JSON.stringify(answer()), { flag: 'wx' });
      await collectPackTask({
        dataset: f.dataset,
        batch: f.ordinary,
        receipt: task.receipt,
        write: true,
        ...(state === 'missing'
          ? { missing: true }
          : state === 'failed'
            ? { error: 'Synthetic reported failure' }
            : {}),
      });
    }
    const saved = await readWorkflowBatch(f.ordinary);
    expect(
      saved.opinions
        .filter((o) => !o.annotation?.registration)
        .map((o) => o.outcome),
    ).toEqual(['missing', 'failed', 'answered']);
    expect(
      saved.opinions.find(
        (o) => !o.annotation?.registration && o.outcome === 'missing',
      )?.annotation?.returned,
    ).toMatchObject({
      error: null,
      metadata: {
        state: 'missing',
        note: 'operator recorded no return at collection cutoff',
      },
    });
    const refs = await workflowReferences({
      root: f.root,
      dataset: f.dataset,
      split: 'dev',
      group: 'f01',
      context: DEFAULT_ANNOTATION_CONTEXT,
    });
    expect(refs.entries[0]?.consensus).toMatchObject({
      n: 3,
      missing: 1,
      failed: 1,
      returned: 1,
      valid: 1,
    });
  });
}, 30000);

test.each(['changed', 'removed'] as const)(
  'adoption uses archived raw after external answer is %s and cannot multiply votes',
  async (state) => {
    await withPack(async (f) => {
      const args = {
        ...f,
        batch: f.baseline,
        attempt: 'neutral',
        channel: 'web' as const,
      };
      const neutral = await createPackTask({ ...args, out: 'neutral' });
      const raw = JSON.stringify(answer());
      await writeFile(neutral.result, raw, { flag: 'wx' });
      const adopt = {
        ...args,
        batch: f.ordinary,
        model: 'synthetic-0',
        origin: neutral.receipt,
        out: 'adopted',
      };
      // An uncollected mutable file is never used as the adoption source.
      await expect(createPackTask(adopt)).rejects.toThrow(/ENOENT/u);
      await collectPackTask({
        dataset: f.dataset,
        batch: f.baseline,
        receipt: neutral.receipt,
        write: false,
      });
      if (state === 'changed')
        await writeFile(
          neutral.result,
          JSON.stringify(answer({ pairs: [[9, 1]] })),
        );
      else await rm(neutral.result);
      const adopted = await createPackTask(adopt);
      expect(await readFile(adopted.result, 'utf8')).toBe(raw);
      expect(await createPackTask(adopt)).toEqual(adopted);
      for (const model of ['synthetic-1', 'synthetic-2']) {
        await expect(
          createPackTask({ ...adopt, model, out: model }),
        ).rejects.toThrow(/already adopted/u);
      }
      const another = join(f.root, 'pack/private/registered/another.json');
      await registerPreparedPack({
        root: f.root,
        dataset: f.dataset,
        prepared: f.baseline,
        models: models(3),
        out: another,
        write: true,
      });
      await expect(
        createPackTask({ ...adopt, batch: another, out: 'another' }),
      ).rejects.toThrow(/already adopted/u);
      await collectPackTask({
        dataset: f.dataset,
        batch: f.ordinary,
        receipt: adopted.receipt,
        write: true,
      });
      await collectPackTask({
        dataset: f.dataset,
        batch: f.ordinary,
        receipt: adopted.receipt,
        write: true,
      });
      const refs = await workflowReferences({
        root: f.root,
        dataset: f.dataset,
        split: 'dev',
        group: 'f01',
        context: DEFAULT_ANNOTATION_CONTEXT,
      });
      expect(refs.entries[0]?.consensus).toMatchObject({
        n: 3,
        k: 1,
        valid: 1,
        pair: null,
      });
      // The collection boundary also checks the claim, even with a syntactically valid receipt.
      const receipt: unknown = JSON.parse(
        await readFile(adopted.receipt, 'utf8'),
      );
      if (typeof receipt !== 'object' || receipt === null)
        throw new Error('receipt');
      await writeFile(
        adopted.receipt,
        JSON.stringify({ ...receipt, modelKey: 'synthetic-1' }),
      );
      await expect(
        collectPackTask({
          dataset: f.dataset,
          batch: f.ordinary,
          receipt: adopted.receipt,
          write: true,
        }),
      ).rejects.toThrow(/claim/u);
    });
  },
  30000,
);

test('archive identity and exclusive origin claims survive competing adoption attempts', async () => {
  await withPack(async (f) => {
    const neutral = await createPackTask({
      ...f,
      batch: f.baseline,
      attempt: 'neutral',
      out: 'neutral',
      channel: 'file',
    });
    await writeFile(neutral.result, JSON.stringify(answer()), { flag: 'wx' });
    await collectPackTask({
      dataset: f.dataset,
      batch: f.baseline,
      receipt: neutral.receipt,
      write: false,
    });
    const archivePath = neutral.receipt.replace(/\.json$/u, '.return.json');
    const archive = await readFile(archivePath, 'utf8');
    const record: unknown = JSON.parse(archive);
    if (typeof record !== 'object' || record === null)
      throw new Error('archive');
    await writeFile(
      archivePath,
      JSON.stringify({ ...record, responseId: 'wrong-origin' }),
    );
    const args = {
      ...f,
      batch: f.ordinary,
      attempt: 'adopt',
      origin: neutral.receipt,
      channel: 'file' as const,
    };
    await expect(
      createPackTask({ ...args, model: 'synthetic-0', out: 'bad' }),
    ).rejects.toThrow(/archive/u);
    await writeFile(archivePath, archive);
    const results = await Promise.allSettled(
      [0, 1, 2].map((i) =>
        createPackTask({
          ...args,
          model: `synthetic-${String(i)}`,
          out: `competing-${String(i)}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    const winner = results.find((r) => r.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('winner');
    await collectPackTask({
      dataset: f.dataset,
      batch: f.ordinary,
      receipt: winner.value.receipt,
      write: true,
    });
    const refs = await workflowReferences({
      root: f.root,
      dataset: f.dataset,
      split: 'dev',
      group: 'f01',
      context: DEFAULT_ANNOTATION_CONTEXT,
    });
    expect(refs.entries[0]?.consensus).toMatchObject({
      n: 3,
      k: 1,
      valid: 1,
      pair: null,
    });
  });
}, 30000);
