import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { withDataset } from '../evals/helpers/dataset.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';
import type { WebForm } from '../../evals/src/annotation/web-types.js';
import type { WorkflowLabel } from '../../evals/src/data/group-types.js';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const isolatedHome = await fs.mkdtemp(
  join(tmpdir(), 'arbiter-web-recovery-home-'),
);
process.env['DSH_HOME'] = isolatedHome;
const { AnnotationWorkspace } =
  await import('../../evals/src/annotation/web-workspace.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { workflowState, workflowRecords } =
  await import('../../evals/src/annotation/workflow-store.js');
const { withWorkflowAnnotation, returns } =
  await import('../evals/helpers/workflow-annotation.js');
const { importWorkflowOpinions, importWorkflowHuman } =
  await import('../../evals/src/annotation/workflow-service.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
afterAll(async () => {
  await fs.rm(isolatedHome, { recursive: true, force: true });
});
const form: WebForm = {
  pairs: '3,10',
  behaviour: 'deny',
  rationale: 'Synthetic retry test',
  evidence: '可以清理生成目录 build/；保留 assets/。',
  author: 'synthetic-tester',
  state: 'confirmed',
};
describe(
  'annotation publication and recovery against real files',
  { timeout: 30_000 },
  () => {
    test('a real human CAS race after durable intent can be explicitly settled without changing the competing label', async () => {
      await withDataset(async (f) => {
        await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
        const scope = {
          root: f.path,
          dataset: join(f.path, 'data'),
          split: 'dev' as const,
          group: 'f01',
          mode: 'blind' as const,
          context: DEFAULT_ANNOTATION_CONTEXT,
        };
        const workspace = await AnnotationWorkspace.open(scope);
        const token = (await workspace.bootstrap()).points[0]?.token;
        if (token === undefined) throw new Error('fixture');
        const opened = await workspace.point(token);
        const file = (await fs.readdir(workspace.directory)).find((name) =>
          /^[a-f0-9-]{36}\.json$/u.test(name),
        );
        const baseline = join(workspace.directory, file ?? 'missing'),
          batch = await readWorkflowBatch(baseline),
          external = join(f.path, 'external-batch.json');
        await fs.writeFile(external, await fs.readFile(baseline));
        const actual = await vi.importActual<typeof fs>('node:fs/promises');
        let injected = false;
        vi.mocked(fs.rename).mockImplementation(async (from, to) => {
          await actual.rename(from, to);
          if (String(to) === workspace.path && !injected) {
            injected = true;
            await importWorkflowHuman({
              dataset: scope.dataset,
              baseline: external,
              write: true,
              fill: {
                batchId: batch.batchId,
                decisions: [
                  {
                    questionId: token,
                    state: 'confirmed',
                    target: {
                      status: 'approved',
                      allowed: { risk: [3], authorization: [10] },
                      allowedPairs: [[3, 10]],
                      behaviourReference: 'deny',
                      rationale: 'Concurrent other human decision',
                      decidedBy: 'synthetic-other',
                      decidedAt: '2026-11-02',
                    },
                  },
                ],
              },
            });
          }
        });
        try {
          await expect(
            workspace.confirm({
              token,
              revision: opened.revision,
              form,
              sampled: false,
            }),
          ).rejects.toMatchObject({ published: null });
        } finally {
          vi.mocked(fs.rename).mockImplementation(actual.rename);
        }
        const pending = await workspace.point(token),
          before = await fs.readFile(
            join(scope.dataset, 'dev/f01/labels.json'),
            'utf8',
          );
        expect(pending.publicationPending).toBe(true);
        await expect(workspace.rebase(token, pending.revision)).rejects.toThrow(
          /confirmation pending/u,
        );
        const settled = await workspace.settle(token, pending.revision);
        expect(settled).toMatchObject({
          status: 'draft',
          publicationPending: false,
          form,
        });
        expect(
          await fs.readFile(join(scope.dataset, 'dev/f01/labels.json'), 'utf8'),
        ).toBe(before);
        const reviewed = await workspace.rebase(token, settled.revision);
        expect(
          (
            await workspace.confirm({
              token,
              revision: reviewed.revision,
              form,
              sampled: false,
            })
          ).status,
        ).toBe('confirmed');
      });
    });
    test('published intent settlement finishes the private checkpoint without rewriting labels', async () => {
      await withDataset(async (f) => {
        await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
        const dataset = join(f.path, 'data'),
          workspace = await AnnotationWorkspace.open({
            root: f.path,
            dataset,
            split: 'dev',
            group: 'f01',
            mode: 'blind',
            context: DEFAULT_ANNOTATION_CONTEXT,
          });
        const token = (await workspace.bootstrap()).points[0]?.token;
        if (token === undefined) throw new Error('fixture');
        const point = await workspace.point(token),
          actual = await vi.importActual<typeof fs>('node:fs/promises');
        vi.mocked(fs.rename)
          .mockImplementationOnce(actual.rename)
          .mockImplementationOnce(actual.rename)
          .mockRejectedValueOnce(new Error('checkpoint failure'));
        await expect(
          workspace.confirm({
            token,
            revision: point.revision,
            form,
            sampled: false,
          }),
        ).rejects.toMatchObject({ published: true });
        const before = await fs.readFile(
          join(dataset, 'dev/f01/labels.json'),
          'utf8',
        );
        const settled = await workspace.settle(token, point.revision);
        expect(settled).toMatchObject({
          status: 'confirmed',
          publicationPending: false,
          decisionDate: new Date().toISOString().slice(0, 10),
        });
        expect(
          await fs.readFile(join(dataset, 'dev/f01/labels.json'), 'utf8'),
        ).toBe(before);
      });
    });
    test('an unreadable current label leaves intent untouched rather than guessing a settlement', async () => {
      await withDataset(async (f) => {
        await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
        const dataset = join(f.path, 'data'),
          workspace = await AnnotationWorkspace.open({
            root: f.path,
            dataset,
            split: 'dev',
            group: 'f01',
            mode: 'blind',
            context: DEFAULT_ANNOTATION_CONTEXT,
          });
        const token = (await workspace.bootstrap()).points[0]?.token;
        if (token === undefined) throw new Error('fixture');
        const point = await workspace.point(token),
          actual = await vi.importActual<typeof fs>('node:fs/promises');
        vi.mocked(fs.rename)
          .mockImplementationOnce(actual.rename)
          .mockImplementationOnce(actual.rename)
          .mockRejectedValueOnce(new Error('checkpoint failure'));
        await expect(
          workspace.confirm({
            token,
            revision: point.revision,
            form,
            sampled: false,
          }),
        ).rejects.toMatchObject({ published: true });
        const before = await fs.readFile(workspace.path, 'utf8');
        await fs.writeFile(join(dataset, 'dev/f01/labels.json'), '{invalid');
        await expect(
          workspace.settle(token, point.revision),
        ).rejects.toMatchObject({ published: null });
        expect(await fs.readFile(workspace.path, 'utf8')).toBe(before);
      });
    });
    test('blind writes preserve an existing human label with valid opinion links without opening the opinion file', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const records = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        const cache = records.labels[0];
        if (cache?.annotation === undefined) throw new Error('fixture');
        const human: WorkflowLabel = {
          ...cache,
          referenceId: 'supported-human',
          source: 'human',
          humanConfirmed: true,
          scoringEligible: true,
          annotation: {
            binding: cache.annotation.binding,
            humanState: 'confirmed',
          },
          target: {
            ...cache.target,
            status: 'approved',
            rationale: 'Synthetic pre-existing human reference',
            decidedBy: 'synthetic-other',
            decidedAt: '2026-11-02',
          },
        };
        await fs.writeFile(
          join(f.dataset, 'dev/f01/labels.json'),
          JSON.stringify(collectionOf(...records.labels, human)),
        );
        await workflowState(f.dataset, 'dev', 'f01');
        const opinionPath = join(f.dataset, 'dev/f01/opinions.json'),
          original = await fs.readFile(opinionPath, 'utf8');
        await fs.writeFile(opinionPath, 'POISON_OPINIONS_DO_NOT_READ {');
        const workspace = await AnnotationWorkspace.open({
          root: f.root,
          dataset: f.dataset,
          split: 'dev',
          group: 'f01',
          mode: 'blind',
          context: DEFAULT_ANNOTATION_CONTEXT,
        });
        const token = (await workspace.bootstrap()).points[1]?.token;
        if (token === undefined) throw new Error('fixture');
        const point = await workspace.point(token);
        await workspace.confirm({
          token,
          revision: point.revision,
          form: {
            ...form,
            state: 'needs-review',
            pairs: '',
            behaviour: '',
            evidence: '',
          },
          sampled: false,
        });
        expect(
          workflowRecords(
            await workflowState(f.dataset, 'dev', 'f01', true),
          ).labels.find((label) => label.referenceId === human.referenceId),
        ).toEqual(human);
        expect(await fs.readFile(opinionPath, 'utf8')).toBe(
          'POISON_OPINIONS_DO_NOT_READ {',
        );
        await fs.writeFile(opinionPath, original);
        expect(
          workflowRecords(await workflowState(f.dataset, 'dev', 'f01')).labels,
        ).toHaveLength(3);
      });
    });
    test.each(['labels', 'checkpoint', 'workspace'] as const)(
      'a %s rename failure reports publication truth and resumes the durable intent after restart',
      async (stage) => {
        await withDataset(async (f) => {
          await f.write(
            'data/dev/f01/workflows.json',
            collectionOf(workflow()),
          );
          const scope = {
            root: f.path,
            dataset: join(f.path, 'data'),
            split: 'dev' as const,
            group: 'f01',
            mode: 'blind' as const,
            context: DEFAULT_ANNOTATION_CONTEXT,
          };
          const workspace = await AnnotationWorkspace.open(scope);
          const token = (await workspace.bootstrap()).points[0]?.token;
          if (token === undefined) throw new Error('fixture');
          const point = await workspace.point(token);
          const actual = await vi.importActual<typeof fs>('node:fs/promises');
          let failed = false,
            workspaceWrites = 0;
          vi.mocked(fs.rename).mockImplementation(async (from, to) => {
            const destination = String(to);
            if (destination === workspace.path) workspaceWrites += 1;
            const selected =
              stage === 'labels'
                ? destination.endsWith('/labels.json')
                : stage === 'checkpoint'
                  ? destination.startsWith(workspace.directory) &&
                    /[a-f0-9-]{36}\.json$/u.test(destination)
                  : destination === workspace.path && workspaceWrites === 2;
            if (selected && !failed) {
              failed = true;
              throw new Error('injected real publication boundary failure');
            }
            await actual.rename(from, to);
          });
          try {
            await expect(
              workspace.confirm({
                token,
                revision: point.revision,
                form,
                sampled: false,
              }),
            ).rejects.toMatchObject({ published: stage !== 'labels' });
            const records = workflowRecords(
              await workflowState(scope.dataset, 'dev', 'f01', true),
            );
            expect(records.labels).toHaveLength(stage === 'labels' ? 0 : 1);
          } finally {
            vi.mocked(fs.rename).mockImplementation(actual.rename);
          }
          const restarted = await AnnotationWorkspace.open(scope);
          const pending = await restarted.point(token);
          expect(pending.publicationPending).toBe(true);
          expect(pending.decisionDate).toBe(
            new Date().toISOString().slice(0, 10),
          );
          await expect(
            restarted.rebase(token, pending.revision),
          ).rejects.toThrow(/confirmation pending/u);
          expect((await restarted.point(token)).publicationPending).toBe(true);
          expect(pending.form).toEqual(form);
          const done = await restarted.confirm({
            token,
            revision: pending.revision,
            form,
            sampled: false,
          });
          expect(done).toMatchObject({
            status: 'confirmed',
            publicationPending: false,
          });
          expect(
            workflowRecords(
              await workflowState(scope.dataset, 'dev', 'f01', true),
            ).labels,
          ).toHaveLength(1);
          expect(
            (await fs.readdir(join(scope.dataset, 'dev/f01'))).filter((name) =>
              name.startsWith('.'),
            ),
          ).toEqual([]);
        });
      },
    );
    test('draft rename failure retains the previous durable form and rejects stale revisions/concurrent claims', async () => {
      await withDataset(async (f) => {
        await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
        const workspace = await AnnotationWorkspace.open({
          root: f.path,
          dataset: join(f.path, 'data'),
          split: 'dev',
          group: 'f01',
          mode: 'blind',
          context: DEFAULT_ANNOTATION_CONTEXT,
        });
        const token = (await workspace.bootstrap()).points[0]?.token;
        if (token === undefined) throw new Error('fixture');
        const point = await workspace.point(token),
          before = await fs.readFile(workspace.path, 'utf8');
        vi.mocked(fs.rename).mockRejectedValueOnce(
          new Error('draft storage unavailable'),
        );
        await expect(
          workspace.save({
            token,
            revision: point.revision,
            form,
            sampled: false,
          }),
        ).rejects.toThrow(/storage unavailable/u);
        expect(await fs.readFile(workspace.path, 'utf8')).toBe(before);
        const saved = await workspace.save({
          token,
          revision: point.revision,
          form,
          sampled: false,
        });
        await expect(
          workspace.save({
            token,
            revision: point.revision,
            form,
            sampled: false,
          }),
        ).rejects.toThrow(/conflict/u);
        const lock = await fs.open(
          join(workspace.directory, '.draft.lock'),
          'wx',
        );
        try {
          await expect(
            workspace.save({
              token,
              revision: saved.revision,
              form,
              sampled: false,
            }),
          ).rejects.toMatchObject({ code: 'EEXIST' });
        } finally {
          await lock.close();
          await fs.rm(join(workspace.directory, '.draft.lock'));
        }
      });
    });
    test('assisted startup/drafts preserve machine caches and opinions; explicit loading returns only current view, and selection never confirms', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const before = await fs.readFile(
          join(f.dataset, 'dev/f01/opinions.json'),
          'utf8',
        );
        const workspace = await AnnotationWorkspace.open({
          root: f.root,
          dataset: f.dataset,
          split: 'dev',
          group: 'f01',
          mode: 'assisted',
          context: DEFAULT_ANNOTATION_CONTEXT,
        });
        const token = (await workspace.bootstrap()).points[0]?.token;
        if (token === undefined) throw new Error('fixture');
        const point = await workspace.point(token);
        expect(point.form.pairs).toBe('');
        const opinions = await workspace.opinions(token);
        expect(
          opinions.opinions.filter((value) => value.complete),
        ).toHaveLength(3);
        expect((await workspace.point(token)).exposed).toBe(true);
        expect(JSON.stringify(opinions)).not.toMatch(
          /retryKey|responseHash|promptFingerprint/u,
        );
        const saved = await workspace.save({
          token,
          revision: point.revision,
          form,
          sampled: true,
        });
        await workspace.confirm({
          token,
          revision: saved.revision,
          form,
          sampled: true,
        });
        expect(
          await fs.readFile(join(f.dataset, 'dev/f01/opinions.json'), 'utf8'),
        ).toBe(before);
        const records = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        expect(
          records.labels.filter((label) => label.source === 'model-consensus'),
        ).toHaveLength(1);
        expect(
          records.labels.filter((label) => label.source === 'human'),
        ).toHaveLength(1);
      });
    });
  },
);
