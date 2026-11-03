import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  symlink,
  open,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { exportWorkflowBatch } from '../../evals/src/annotation/workflow-export.js';
import { readWorkflowBatch } from '../../evals/src/annotation/workflow-batch-read.js';
import {
  importWorkflowHuman,
  importWorkflowOpinions,
  workflowReferences,
} from '../../evals/src/annotation/workflow-service.js';
import {
  DEFAULT_ANNOTATION_CONTEXT,
  independentQuestion,
  buildAnnotationView,
  workflowSource,
} from '../../evals/src/annotation/workflow-view.js';
import {
  workflowRecords,
  workflowState,
} from '../../evals/src/annotation/workflow-store.js';
import { runWorkflowAnnotationCli } from '../../evals/src/annotation/workflow-command.js';
import {
  withWorkflowAnnotation,
  returns,
  models,
  answer,
} from '../evals/helpers/workflow-annotation.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';

const scope = {
  split: 'dev' as const,
  group: 'f01',
  context: DEFAULT_ANNOTATION_CONTEXT,
};
describe(
  'workflow annotation real files, all opinions and dynamic references',
  { timeout: 30_000 },
  () => {
    test('exports each actual point separately, excludes author/future/holdout, and registers missing models immediately', async () => {
      await withWorkflowAnnotation(async (f) => {
        const files = await readdir(f.out);
        expect(
          files.filter((file) => /^[a-f0-9-]{36}\.json$/u.test(file)),
        ).toHaveLength(f.batch.points.length);
        const first = f.batch.points[0];
        if (first === undefined) throw new Error('fixture');
        const pack = await readFile(
          join(f.out, `${first.questionId}.json`),
          'utf8',
        );
        for (const sentinel of [
          'AUTHOR_SENTINEL',
          'FUTURE_FAILURE_SENTINEL',
          'format-build',
          'format-clean',
          'format-only',
          'OPINION_SENTINEL',
        ])
          expect(pack).not.toContain(sentinel);
        expect(pack).toContain('唯一有效的回答格式');
        expect(pack).toContain('behaviourReference');
        const source = await workflowSource(f.dataset, 'dev', 'f01');
        const built = await buildAnnotationView(
          source,
          first.rootId,
          first.pointId,
          scope.context,
        );
        expect(JSON.parse(pack)).toEqual(
          independentQuestion(first.questionId, built.request),
        );
        await mkdir(join(f.dataset, 'holdout/f01'), { recursive: true });
        await writeFile(
          join(f.dataset, 'holdout/f01/workflows.json'),
          '{broken',
        );
        const snapshot = await workflowReferences({
          ...scope,
          dataset: f.dataset,
        });
        expect(snapshot.entries[0]?.consensus?.n).toBe(3);
        expect(snapshot.entries[0]?.consensus?.missing).toBe(3);
        expect(snapshot.entries[0]?.source).toBe('unresolved');
        expect((await workflowState(f.dataset, 'dev', 'f01')).problems).toEqual(
          [],
        );
      });
    });
    test('model forward/import roundtrip preserves raw and unknown metadata, is idempotent and never confirms a human', async () => {
      await withWorkflowAnnotation(async (f) => {
        const returned = returns(f.batch);
        const first = returned.responses[0];
        if (first === undefined) throw new Error('fixture');
        const decorated = {
          ...returned,
          responses: [
            {
              ...first,
              metadata: { unknownProviderField: 'retained-visible-metadata' },
            },
            ...returned.responses.slice(1),
          ],
        };
        expect(
          (
            await importWorkflowOpinions({
              ...f,
              returned: decorated,
              write: false,
            })
          ).responses,
        ).toBe(3);
        expect(
          workflowRecords(await workflowState(f.dataset, 'dev', 'f01')).labels,
        ).toEqual([]);
        await importWorkflowOpinions({
          ...f,
          returned: decorated,
          write: true,
        });
        const before = await readFile(
          join(f.dataset, 'dev/f01/opinions.json'),
          'utf8',
        );
        await importWorkflowOpinions({
          ...f,
          returned: decorated,
          write: true,
        });
        expect(
          await readFile(join(f.dataset, 'dev/f01/opinions.json'), 'utf8'),
        ).toBe(before);
        const state = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        const raw = state.opinions.find(
          (value) => value.opinion.reviewId === first.responseId,
        );
        expect(raw?.annotation?.rawResponse).toBe(first.rawResponse);
        expect(raw?.annotation?.returned).toMatchObject({
          metadata: { unknownProviderField: 'retained-visible-metadata' },
        });
        expect(raw?.responseRef).toBe(
          `opinion:${first.responseId}#annotation/rawResponse`,
        );
        const current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.source).toBe('model-consensus');
        expect(current?.humanConfirmed).toBe(false);
        expect(current?.reference?.target.allowedPairs).toEqual([[3, 10]]);
        expect(current?.reference?.target.status).toBe('pending');
        await rm(join(f.root, '.local'), { recursive: true });
        const restored = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        ).opinions.find((value) => value.opinion.reviewId === first.responseId);
        expect(restored?.annotation?.rawResponse).toBe(first.rawResponse);
        expect(restored?.annotation?.parsed).toEqual(answer());
      });
    });
    test('new registration immediately revokes old consensus, partial replies retain N, cross-batch completion passes grouped checks', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const frozen = await workflowReferences({
          ...scope,
          dataset: f.dataset,
        });
        const frozenFile = join(f.root, 'fixed-comparison.json');
        await writeFile(frozenFile, JSON.stringify(frozen));
        const second = await exportWorkflowBatch({
          root: f.root,
          dataset: f.dataset,
          split: 'dev',
          group: 'f01',
          models: models(2, 3),
          context: scope.context,
          out: join(f.root, 'second-pack'),
        });
        let current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.consensus?.n).toBe(5);
        expect(current?.consensus?.missing).toBe(2);
        expect(current?.source).toBe('unresolved');
        await importWorkflowOpinions({
          dataset: f.dataset,
          baseline: second.baseline,
          returned: returns(second.batch, {}, ['synthetic-3']),
          write: true,
        });
        current = (await workflowReferences({ ...scope, dataset: f.dataset }))
          .entries[0];
        expect(current?.consensus?.n).toBe(5);
        expect(current?.consensus?.missing).toBe(1);
        expect(current?.source).toBe('unresolved');
        await importWorkflowOpinions({
          dataset: f.dataset,
          baseline: second.baseline,
          returned: returns(second.batch, { pairs: [[4, 9]] }, ['synthetic-4']),
          write: true,
        });
        current = (await workflowReferences({ ...scope, dataset: f.dataset }))
          .entries[0];
        expect(current?.source).toBe('model-consensus');
        expect(current?.consensus?.k).toBe(4);
        expect(current?.reference?.target.allowedPairs).toEqual([[3, 10]]);
        expect((await workflowState(f.dataset, 'dev', 'f01')).problems).toEqual(
          [],
        );
        expect(await readFile(frozenFile, 'utf8')).toBe(JSON.stringify(frozen));
        expect(frozen.entries[0]?.consensus?.n).toBe(3);
      });
    });
    test('parse failures and multi-pair replies persist, repair succeeds but a later repeat cannot replace a complete multiple-pair opinion', async () => {
      await withWorkflowAnnotation(async (f) => {
        const returned = returns(f.batch);
        const first = returned.responses[0];
        if (first === undefined) throw new Error('fixture');
        const broken = {
          ...returned,
          responses: [
            {
              ...first,
              rawResponse: 'not JSON: actual synthetic visible failure',
            },
            ...returned.responses.slice(1),
          ],
        };
        await importWorkflowOpinions({ ...f, returned: broken, write: true });
        let current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.consensus?.n).toBe(3);
        expect(current?.consensus?.failed).toBe(1);
        expect(current?.source).toBe('unresolved');
        await importWorkflowOpinions({
          ...f,
          returned: returns(
            f.batch,
            {
              pairs: [
                [3, 10],
                [4, 9],
              ],
            },
            ['synthetic-0'],
          ),
          write: true,
        });
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch, {}, ['synthetic-0']),
          write: true,
        });
        current = (await workflowReferences({ ...scope, dataset: f.dataset }))
          .entries[0];
        expect(current?.consensus?.n).toBe(3);
        expect(current?.source).toBe('unresolved');
        expect(current?.consensus?.reasons).toContain(
          'multiple-reasonable-pairs',
        );
        const state = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        expect(
          state.opinions.find(
            (value) => value.opinion.reviewId === first.responseId,
          )?.annotation?.rawResponse,
        ).toBe('not JSON: actual synthetic visible failure');
        expect(
          state.opinions.filter(
            (value) =>
              value.annotation?.modelKey === 'synthetic-0' &&
              !value.annotation.registration,
          ),
        ).toHaveLength(3);
        await expect(
          importWorkflowOpinions({
            ...f,
            returned: {
              ...returned,
              responses: [{ ...first, rawResponse: JSON.stringify(answer()) }],
            },
            write: true,
          }),
        ).rejects.toThrow(/immutable|conflict/u);
      });
    });
    test('two batches of two produce one traceable reference; missing and cross-point support IDs are rejected', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const second = await exportWorkflowBatch({
          root: f.root,
          dataset: f.dataset,
          ...scope,
          models: models(2, 2),
          out: join(f.root, 'two-more'),
        });
        await importWorkflowOpinions({
          dataset: f.dataset,
          baseline: second.baseline,
          returned: returns(second.batch),
          write: true,
        });
        const current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.consensus?.n).toBe(4);
        expect(current?.source).toBe('model-consensus');
        const records = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        const label = records.labels[0];
        if (label === undefined) throw new Error('fixture');
        const supported = records.opinions.filter((value) =>
          label.supportingOpinionIds.includes(value.opinion.reviewId),
        );
        expect(new Set(supported.map((value) => value.batchId)).size).toBe(2);
        const path = join(f.dataset, 'dev/f01/labels.json'),
          original = await readFile(path, 'utf8');
        await writeFile(
          path,
          JSON.stringify(
            collectionOf({ ...label, supportingOpinionIds: ['missing-id'] }),
          ),
        );
        await expect(workflowState(f.dataset, 'dev', 'f01')).rejects.toThrow(
          /unknown supporting opinion/u,
        );
        const other = records.opinions.find(
          (value) => value.pointId !== label.pointId,
        );
        if (other === undefined) throw new Error('fixture');
        await writeFile(
          path,
          JSON.stringify(
            collectionOf({
              ...label,
              supportingOpinionIds: [other.opinion.reviewId],
            }),
          ),
        );
        await expect(workflowState(f.dataset, 'dev', 'f01')).rejects.toThrow(
          /another root\/point\/view/u,
        );
        await writeFile(path, original);
        await exportWorkflowBatch({
          root: f.root,
          dataset: f.dataset,
          ...scope,
          models: models(1, 4),
          out: join(f.root, 'third-batch'),
        });
        expect(
          (await workflowReferences({ ...scope, dataset: f.dataset }))
            .entries[0]?.source,
        ).toBe('unresolved');
      }, 2);
    });
    test('updates by stable IDs preserve another point changed after export', async () => {
      await withWorkflowAnnotation(async (f) => {
        const second = f.batch.points[1];
        if (second?.binding === undefined || second.binding === null)
          throw new Error('fixture');
        const unrelated = {
          referenceId: 'unrelated-draft',
          rootId: second.rootId,
          pointId: second.pointId,
          viewId: second.viewId,
          batchId: f.batch.batchId,
          source: 'human',
          humanConfirmed: false,
          scoringEligible: false,
          versions: second.binding.versions,
          supportingOpinionIds: [],
          annotation: { binding: second.binding, humanState: 'draft' },
          target: {
            status: 'pending',
            allowed: { risk: null, authorization: null },
            behaviourReference: null,
            rationale: 'external unrelated draft',
            decidedBy: '',
            decidedAt: null,
          },
        };
        await writeFile(
          join(f.dataset, 'dev/f01/labels.json'),
          JSON.stringify(collectionOf(unrelated)),
        );
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        expect(
          workflowRecords(
            await workflowState(f.dataset, 'dev', 'f01'),
          ).labels.find((value) => value.referenceId === 'unrelated-draft'),
        ).toEqual(unrelated);
      });
    });
    test('human null-behaviour pending survives reload, drafts stay separate, and explicit confirmed behaviour can disagree with matrix', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const questionId = f.batch.points[0]?.questionId;
        if (questionId === undefined) throw new Error('fixture');
        const target = {
          status: 'pending',
          allowed: { risk: null, authorization: null },
          behaviourReference: null,
          rationale: 'Synthetic human fixture: cannot yet determine',
          decidedBy: 'synthetic-human',
          decidedAt: '2026-11-02',
        };
        await importWorkflowHuman({
          ...f,
          fill: {
            batchId: f.batch.batchId,
            decisions: [{ questionId, state: 'undecidable', target }],
          },
          write: true,
        });
        expect(
          (await workflowReferences({ ...scope, dataset: f.dataset }))
            .entries[0]?.reasons,
        ).toContain('explicit-human-pending');
        await importWorkflowHuman({
          ...f,
          fill: {
            batchId: f.batch.batchId,
            decisions: [
              {
                questionId,
                state: 'confirmed',
                target: {
                  ...target,
                  status: 'approved',
                  allowed: { risk: [3], authorization: [10] },
                  allowedPairs: [[3, 10]],
                  behaviourReference: 'deny',
                },
              },
            ],
          },
          write: true,
        });
        await importWorkflowHuman({
          ...f,
          fill: {
            batchId: f.batch.batchId,
            decisions: [{ questionId, state: 'draft', target }],
          },
          write: true,
        });
        const current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.source).toBe('human');
        expect(current?.humanConfirmed).toBe(true);
        expect(current?.reference?.target.behaviourReference).toBe('deny');
        expect(
          workflowRecords(
            await workflowState(f.dataset, 'dev', 'f01'),
          ).opinions.filter((value) => !value.annotation?.registration),
        ).toHaveLength(3);
      });
    });
    test('visible changes reject import, formatting and author notes do not, and real human decisions use CAS', async () => {
      await withWorkflowAnnotation(async (f) => {
        const file = join(f.dataset, 'dev/f01/workflows.json');
        await writeFile(
          file,
          JSON.stringify(
            collectionOf(
              workflow({
                notes: 'changed author-only notes',
                task: 'changed author task',
              }),
            ),
          ),
        );
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        });
        const baseline = await readWorkflowBatch(f.baseline);
        const label = baseline.labels[0];
        if (label?.annotation === undefined) throw new Error('fixture');
        const human = {
          ...label,
          referenceId: 'external-human',
          source: 'human' as const,
          humanConfirmed: true,
          scoringEligible: true,
          annotation: {
            binding: label.annotation.binding,
            humanState: 'confirmed' as const,
          },
          target: {
            ...label.target,
            status: 'approved' as const,
            rationale: 'external synthetic human decision',
            decidedBy: 'synthetic-human',
            decidedAt: '2026-11-02',
          },
        };
        await writeFile(
          join(f.dataset, 'dev/f01/labels.json'),
          JSON.stringify(collectionOf(label, human)),
        );
        await expect(
          importWorkflowHuman({
            ...f,
            fill: {
              batchId: f.batch.batchId,
              decisions: [
                {
                  questionId: f.batch.points[0]?.questionId,
                  state: 'confirmed',
                  target: human.target,
                },
              ],
            },
            write: true,
          }),
        ).rejects.toThrow(/conflict/u);
        await writeFile(
          file,
          JSON.stringify(
            collectionOf(
              workflow({
                events: workflow().events.map((event) =>
                  event.eventId === 'request' && event.kind === 'message'
                    ? { ...event, content: 'Visible scope was narrowed.' }
                    : event,
                ),
              }),
            ),
          ),
        );
        await expect(
          importWorkflowOpinions({
            ...f,
            returned: returns(f.batch),
            write: true,
          }),
        ).rejects.toThrow(/input\/view\/contract changed/u);
      });
    });
    test('unreachable evidence is retained but cannot vote; stable response references are checked', async () => {
      await withWorkflowAnnotation(async (f) => {
        await importWorkflowOpinions({
          ...f,
          returned: returns(f.batch, {
            evidence: ['hidden future authorization'],
          }),
          write: true,
        });
        const current = (
          await workflowReferences({ ...scope, dataset: f.dataset })
        ).entries[0];
        expect(current?.consensus?.n).toBe(3);
        expect(current?.consensus?.valid).toBe(0);
        expect(current?.source).toBe('unresolved');
        const state = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        );
        const first = state.opinions.find(
          (value) => value.responseRef !== null,
        );
        if (first === undefined) throw new Error('fixture');
        await writeFile(
          join(f.dataset, 'dev/f01/opinions.json'),
          JSON.stringify(
            collectionOf(
              ...state.opinions.map((value) =>
                value === first
                  ? { ...value, responseRef: 'missing-attachment' }
                  : value,
              ),
            ),
          ),
        );
        await expect(workflowState(f.dataset, 'dev', 'f01')).rejects.toThrow(
          /raw response reference/u,
        );
      });
    });
    test('selected directory symlinks, output-over-evidence, existing snapshots and a concurrent claim fail safely', async () => {
      await withWorkflowAnnotation(async (f) => {
        await expect(
          exportWorkflowBatch({
            root: f.root,
            dataset: f.dataset,
            ...scope,
            models: models(3),
            out: join(f.dataset, 'overwrite'),
          }),
        ).rejects.toThrow(/protected evidence/u);
        const claim = join(f.dataset, 'dev/f01/.annotation.lock');
        const handle = await open(claim, 'wx');
        try {
          await expect(
            importWorkflowOpinions({
              ...f,
              returned: returns(f.batch),
              write: true,
            }),
          ).rejects.toThrow(/EEXIST/u);
        } finally {
          await handle.close();
          await rm(claim);
        }
        const link = join(f.root, 'alias');
        await symlink(f.dataset, link);
        await expect(workflowState(link, 'dev', 'f01')).rejects.toThrow(
          /symlink/u,
        );
        const errors: string[] = [],
          io = {
            root: f.root,
            out: (_line: string) => {},
            err: (line: string) => {
              errors.push(line);
            },
          };
        const argv = [
          'workflow-reference',
          f.dataset,
          '--group',
          'f01',
          '--out',
          join(f.root, 'snapshot.json'),
        ];
        expect(await runWorkflowAnnotationCli(argv, io)).toBe(0);
        const before = await readFile(join(f.root, 'snapshot.json'), 'utf8');
        expect(await runWorkflowAnnotationCli(argv, io)).toBe(1);
        expect(errors.join()).toContain('EEXIST');
        expect(await readFile(join(f.root, 'snapshot.json'), 'utf8')).toBe(
          before,
        );
      });
    });
  },
);
