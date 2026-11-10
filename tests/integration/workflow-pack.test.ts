/** Isolated synthetic engineering fixtures; never real model/human opinions. */
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
const home = await mkdtemp('/private/tmp/arbiter-pack-home-');
process.env['DSH_HOME'] = home;
const { withDataset } = await import('../evals/helpers/dataset.js');
const { collectionOf, workflow } =
  await import('../evals/fixtures/workflow.js');
const { models, answer } =
  await import('../evals/helpers/workflow-annotation.js');
const { collectPackTask } =
  await import('../../evals/src/annotation/pack-collect.js');
const { createPackTask } =
  await import('../../evals/src/annotation/pack-task.js');
const { registerPreparedPack } =
  await import('../../evals/src/annotation/pack-register.js');
const { prepareWorkflowPack } =
  await import('../../evals/src/annotation/pack-prepare.js');
const { runWorkflowAnnotationCli } =
  await import('../../evals/src/annotation/workflow-command.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('offline model-neutral annotation packs', () => {
  test('exact point preparation has no registration side effects and refuses collisions', async () => {
    await withDataset(async (f) => {
      await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const point = workflow().points[0];
      if (point === undefined) throw new Error('fixture');
      await f.write('selection.json', [
        {
          group: 'f01',
          rootId: workflow().rootId,
          pointId: point.pointId,
          viewId: point.primaryViewId,
        },
      ]);
      await f.write('context.json', DEFAULT_ANNOTATION_CONTEXT);
      const errors: string[] = [];
      const io = {
        root: f.path,
        out: () => {},
        err: (v: string) => errors.push(v),
      };
      const args = [
        'workflow-prepare',
        'data',
        '--selection',
        'selection.json',
        '--context',
        'context.json',
        '--out',
        'pack',
      ];
      expect(await runWorkflowAnnotationCli(args, io)).toBe(0);
      expect(errors).toEqual([]);
      const pack = await readWorkflowBatch(
        join(f.path, 'pack/private/f01.json'),
      );
      expect(pack.models).toEqual([]);
      expect(pack.opinions).toEqual([]);
      expect(pack.points).toHaveLength(1);
      expect(pack.points[0]?.registrations).toEqual([]);
      expect(await readdir(join(f.path, 'data/dev/f01'))).toEqual([
        'workflows.json',
      ]);
      expect(await runWorkflowAnnotationCli(args, io)).toBe(1);
    });
  }, 30000);
  test('real participant registration, task raw collection, preview and immutable retries', async () => {
    await withDataset(async (f) => {
      await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const selected = workflow().points[0];
      if (selected === undefined) throw new Error('fixture');
      const prepared = await prepareWorkflowPack({
        root: f.path,
        dataset: join(f.path, 'data'),
        split: 'dev',
        selection: [
          {
            group: 'f01',
            rootId: workflow().rootId,
            pointId: selected.pointId,
            viewId: selected.primaryViewId,
          },
        ],
        context: DEFAULT_ANNOTATION_CONTEXT,
        out: 'pack',
      });
      expect(prepared.tasks).toHaveLength(1);
      expect(prepared.tasks[0]?.result).toContain('answer.txt');
      const baseline = prepared.batches[0]?.baseline;
      if (baseline === undefined) throw new Error('baseline');
      const neutral = await readWorkflowBatch(baseline),
        point = neutral.points[0];
      if (point === undefined) throw new Error('point');
      const data = neutral.dataset;
      const registeredPath = join(
        f.path,
        'pack/private/registered/models.json',
      );
      const registration = {
        root: f.path,
        dataset: data,
        prepared: baseline,
        models: models(3),
        out: registeredPath,
      };
      await registerPreparedPack({ ...registration, write: false });
      expect(await readdir(join(data, 'dev/f01'))).toEqual(['workflows.json']);
      await registerPreparedPack({ ...registration, write: true });
      const ordinary = await readWorkflowBatch(registeredPath);
      expect(ordinary.points[0]?.questionId).toBe(point.questionId);
      expect(ordinary.points[0]?.binding).toEqual(point.binding);
      const task = await createPackTask({
        root: f.path,
        dataset: data,
        batch: registeredPath,
        question: point.questionId,
        model: 'synthetic-0',
        attempt: 'first',
        out: 'task-1',
        channel: 'file',
      });
      await writeFile(task.result, JSON.stringify(answer()), { flag: 'wx' });
      const before = await readFile(
        join(data, 'dev/f01/opinions.json'),
        'utf8',
      );
      const input = {
        dataset: data,
        batch: registeredPath,
        receipt: task.receipt,
      };
      await collectPackTask({ ...input, write: false });
      expect(await readFile(join(data, 'dev/f01/opinions.json'), 'utf8')).toBe(
        before,
      );
      await collectPackTask({ ...input, write: true });
      const after = await readFile(join(data, 'dev/f01/opinions.json'), 'utf8');
      expect(after).toContain('Synthetic engineering fixture');
      await collectPackTask({ ...input, write: true });
      expect(await readFile(join(data, 'dev/f01/opinions.json'), 'utf8')).toBe(
        after,
      );
      await writeFile(
        task.result,
        JSON.stringify(answer({ rationale: 'changed synthetic payload' })),
      );
      await expect(collectPackTask({ ...input, write: true })).rejects.toThrow(
        /conflict/u,
      );
      expect(await readFile(join(data, 'dev/f01/opinions.json'), 'utf8')).toBe(
        after,
      );
    });
  }, 30000);

  test('neutral attempts isolate outputs, preserve malformed raw and reject unsafe files', async () => {
    await withDataset(async (f) => {
      await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const selected = workflow().points[0];
      if (selected === undefined) throw new Error('fixture');
      const prepared = await prepareWorkflowPack({
        root: f.path,
        dataset: join(f.path, 'data'),
        split: 'dev',
        selection: [
          {
            group: 'f01',
            rootId: workflow().rootId,
            pointId: selected.pointId,
            viewId: selected.primaryViewId,
          },
        ],
        context: DEFAULT_ANNOTATION_CONTEXT,
        out: 'pack',
      });
      const baseline = prepared.batches[0]?.baseline;
      if (baseline === undefined) throw new Error('baseline');
      const batch = await readWorkflowBatch(baseline),
        point = batch.points[0];
      if (point === undefined) throw new Error('point');
      const args = {
        root: f.path,
        dataset: batch.dataset,
        batch: baseline,
        question: point.questionId,
        attempt: 'neutral',
        channel: 'web' as const,
      };
      const first = await createPackTask({ ...args, out: 'neutral-one' });
      const second = await createPackTask({ ...args, out: 'neutral-two' });
      expect(first.modelKey).toBeNull();
      expect(
        await readFile(join(first.directory, 'TASK.txt'), 'utf8'),
      ).toContain(first.result);
      expect(
        await readFile(join(first.directory, 'question.json'), 'utf8'),
      ).not.toMatch(
        /AUTHOR_SENTINEL|FUTURE_FAILURE_SENTINEL|retryKey|modelReferenceId/u,
      );
      expect(first.result).not.toBe(second.result);
      await writeFile(first.result, '{ malformed synthetic raw', {
        flag: 'wx',
      });
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: baseline,
          receipt: first.receipt,
          write: false,
        }),
      ).resolves.toMatchObject({ archived: true, registered: false });
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: baseline,
          receipt: first.receipt,
          write: true,
        }),
      ).rejects.toThrow(/registration/u);
      expect(await readdir(join(batch.dataset, 'dev/f01'))).toEqual([
        'workflows.json',
      ]);
      const ordinary = join(f.path, 'pack/private/registered/actual.json');
      await registerPreparedPack({
        root: f.path,
        dataset: batch.dataset,
        prepared: baseline,
        models: models(1),
        out: ordinary,
        write: true,
      });
      const adopted = await createPackTask({
        ...args,
        batch: ordinary,
        model: 'synthetic-0',
        origin: first.receipt,
        out: 'adopted',
      });
      expect(await readFile(adopted.result, 'utf8')).toBe(
        '{ malformed synthetic raw',
      );
      const adoptedReceipt: unknown = JSON.parse(
        await readFile(adopted.receipt, 'utf8'),
      );
      expect(adoptedReceipt).toMatchObject({
        origin: {
          responseId: first.responseId,
          attempt: 'neutral',
          channel: 'web',
        },
      });
      await collectPackTask({
        dataset: batch.dataset,
        batch: ordinary,
        receipt: adopted.receipt,
        write: true,
      });
      const privateReceiptText = await readFile(second.receipt, 'utf8');
      const receiptRecord: unknown = JSON.parse(privateReceiptText);
      if (typeof receiptRecord !== 'object' || receiptRecord === null)
        throw new Error('receipt');
      await writeFile(
        second.receipt,
        JSON.stringify({
          ...receiptRecord,
          directory: 'redirected-relative-path',
        }),
      );
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: baseline,
          receipt: second.receipt,
          write: false,
        }),
      ).rejects.toThrow(/absolute/u);
      await writeFile(
        second.receipt,
        JSON.stringify({ ...receiptRecord, questionId: 'wrong-question' }),
      );
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: baseline,
          receipt: second.receipt,
          write: false,
        }),
      ).rejects.toThrow(/question/u);
      await writeFile(second.receipt, privateReceiptText);
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: ordinary,
          receipt: second.receipt,
          write: true,
        }),
      ).rejects.toThrow(/another batch/u);
      await symlink(baseline, second.result);
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: baseline,
          receipt: second.receipt,
          write: false,
        }),
      ).rejects.toThrow();
      await expect(
        createPackTask({ ...args, out: 'neutral-one' }),
      ).rejects.toThrow(/exists/u);
      expect(
        await readFile(join(batch.dataset, 'dev/f01/opinions.json'), 'utf8'),
      ).toContain('malformed synthetic raw');
      expect(await readFile(first.result, 'utf8')).toBe(
        '{ malformed synthetic raw',
      );
    });
  }, 30000);

  test('mutated saved request cannot borrow the authentic binding or a matching forged question', async () => {
    await withDataset(async (f) => {
      await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const selected = workflow().points[0];
      if (selected === undefined) throw new Error('fixture');
      const prepared = await prepareWorkflowPack({
        root: f.path,
        dataset: join(f.path, 'data'),
        split: 'dev',
        selection: [
          {
            group: 'f01',
            rootId: workflow().rootId,
            pointId: selected.pointId,
            viewId: selected.primaryViewId,
          },
        ],
        context: DEFAULT_ANNOTATION_CONTEXT,
        out: 'pack',
      });
      const baseline = prepared.batches[0]?.baseline;
      if (baseline === undefined) throw new Error('baseline');
      const batch = await readWorkflowBatch(baseline),
        point = batch.points[0];
      if (point === undefined) throw new Error('point');
      const task = await createPackTask({
        root: f.path,
        dataset: batch.dataset,
        batch: baseline,
        question: point.questionId,
        attempt: 'original',
        out: 'task',
        channel: 'file',
      });
      await writeFile(task.result, JSON.stringify(answer()));
      const alteredRequest = {
        injected: 'AUTHOR_EXPECTED: allow',
        original: point.request,
      };
      await writeFile(
        baseline,
        JSON.stringify({
          ...batch,
          points: [{ ...point, request: alteredRequest }],
        }),
      );
      const publicQuestion: unknown = JSON.parse(
        await readFile(join(task.directory, 'question.json'), 'utf8'),
      );
      if (typeof publicQuestion !== 'object' || publicQuestion === null)
        throw new Error('fixture question');
      await writeFile(
        join(task.directory, 'question.json'),
        JSON.stringify({
          ...publicQuestion,
          productionRequest: alteredRequest,
        }),
      );
      await expect(
        createPackTask({
          root: f.path,
          dataset: batch.dataset,
          batch: baseline,
          question: point.questionId,
          attempt: 'forged',
          out: 'forged',
          channel: 'file',
        }),
      ).rejects.toThrow(/altered/u);
      await expect(
        registerPreparedPack({
          root: f.path,
          dataset: batch.dataset,
          prepared: baseline,
          models: models(1),
          out: join(f.path, 'pack/private/registered/model.json'),
          write: true,
        }),
      ).rejects.toThrow(/altered/u);
      await expect(
        collectPackTask({
          dataset: batch.dataset,
          batch: baseline,
          receipt: task.receipt,
          write: false,
        }),
      ).rejects.toThrow(/altered/u);
      expect(await readdir(join(batch.dataset, 'dev/f01'))).toEqual([
        'workflows.json',
      ]);
    });
  }, 30000);
});
