import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { withDataset } from '../evals/helpers/dataset.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';
import type { WebForm } from '../../evals/src/annotation/web-types.js';
const isolatedHome = await mkdtemp(join(tmpdir(), 'arbiter-web-review-home-'));
process.env['DSH_HOME'] = isolatedHome;
const { AnnotationWorkspace } =
  await import('../../evals/src/annotation/web-workspace.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { workflowState, workflowRecords } =
  await import('../../evals/src/annotation/workflow-store.js');
const { importWorkflowHuman, importWorkflowOpinions } =
  await import('../../evals/src/annotation/workflow-service.js');
const { withWorkflowAnnotation, returns, models } =
  await import('../evals/helpers/workflow-annotation.js');
const { exportWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-export.js');
const { opinionReport } =
  await import('../../evals/src/annotation/web-opinion-report.js');
afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});
const form: WebForm = {
  pairs: '3,10',
  behaviour: 'deny',
  rationale: 'Synthetic human reasoning',
  evidence: '可以清理生成目录 build/；保留 assets/。',
  author: 'synthetic-tester',
  state: 'confirmed',
};
describe('annotation PR regression contracts', { timeout: 30_000 }, () => {
  test('stale rebase cannot overwrite a newer draft across two workspaces; explicit reload exposes the newer form', async () => {
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
      const a = await AnnotationWorkspace.open(scope);
      const token = (await a.bootstrap()).points[0]?.token;
      if (token === undefined) throw new Error('fixture');
      const opened = await a.point(token);
      const b = await AnnotationWorkspace.open(scope);
      await b.point(token);
      const newer = { ...form, rationale: 'Newer page A input' };
      const saved = await a.save({
        token,
        revision: opened.revision,
        form: newer,
        sampled: false,
      });
      await expect(b.rebase(token, opened.revision)).rejects.toThrow(
        /conflict/u,
      );
      const loaded = await b.point(token, true);
      expect(loaded.form).toEqual(newer);
      await expect(b.rebase(token, opened.revision)).rejects.toThrow(
        /conflict/u,
      );
      expect((await b.point(token)).form).toEqual(newer);
      const reviewed = await b.rebase(token, saved.revision);
      expect(reviewed.form).toEqual(newer);
      expect(reviewed.viewToken).not.toBe(opened.viewToken);
    });
  });
  test('explicit no-score confirmation persists approved independent behaviour, never treats a blank pair as that choice', async () => {
    await withDataset(async (f) => {
      await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const dataset = join(f.path, 'data');
      const workspace = await AnnotationWorkspace.open({
        root: f.path,
        dataset,
        split: 'dev',
        group: 'f01',
        mode: 'blind',
        context: DEFAULT_ANNOTATION_CONTEXT,
      });
      const token = (await workspace.bootstrap()).points[0]?.token;
      if (token === undefined) throw new Error('fixture');
      const point = await workspace.point(token);
      expect(point.decisionDate).toBeNull();
      const insufficient: WebForm = {
        ...form,
        pairs: '',
        behaviour: 'insufficient-material',
        evidence: '',
      };
      await expect(
        workspace.confirm({
          token,
          revision: point.revision,
          form: insufficient,
          sampled: false,
        }),
      ).rejects.toThrow(/confirmation requires/u);
      const confirmed = await workspace.confirm({
        token,
        revision: point.revision,
        form: { ...insufficient, noScores: true },
        sampled: false,
      });
      expect(confirmed).toMatchObject({
        status: 'confirmed',
        referenceStatus: 'confirmed',
        decisionDate: new Date().toISOString().slice(0, 10),
      });
      expect(
        workflowRecords(await workflowState(dataset, 'dev', 'f01', true))
          .labels[0],
      ).toMatchObject({
        humanConfirmed: true,
        target: {
          status: 'approved',
          allowed: { risk: null, authorization: null },
          behaviourReference: 'insufficient-material',
        },
      });
    });
  });
  test('formal human progress reconciles prior CLI decisions and external deletion without revealing the other human answer', async () => {
    await withWorkflowAnnotation(async (f) => {
      const oldPoint = f.batch.points[0];
      if (oldPoint === undefined) throw new Error('fixture');
      await importWorkflowHuman({
        ...f,
        write: true,
        fill: {
          batchId: f.batch.batchId,
          decisions: [
            {
              questionId: oldPoint.questionId,
              state: 'confirmed',
              target: {
                status: 'approved',
                allowed: { risk: null, authorization: null },
                behaviourReference: 'insufficient-material',
                rationale: 'EXTERNAL_HUMAN_ANSWER_SENTINEL',
                decidedBy: 'external-author-secret',
                decidedAt: '2025-01-01',
              },
            },
          ],
        },
      });
      const scope = {
        root: f.root,
        dataset: f.dataset,
        split: 'dev' as const,
        group: 'f01',
        mode: 'blind' as const,
        context: DEFAULT_ANNOTATION_CONTEXT,
      };
      const workspace = await AnnotationWorkspace.open(scope);
      const bootstrap = await workspace.bootstrap();
      expect(bootstrap.points[0]).toMatchObject({
        status: 'unopened',
        referenceStatus: 'confirmed',
      });
      expect(JSON.stringify(bootstrap)).not.toMatch(
        /EXTERNAL_HUMAN_ANSWER_SENTINEL|external-author-secret/u,
      );
      const token = bootstrap.points[0]?.token;
      if (token === undefined) throw new Error('fixture');
      const opened = await workspace.point(token);
      expect(opened.form.rationale).toBe('');
      expect(opened.decisionDate).toBeNull();
      const own = await workspace.confirm({
        token,
        revision: opened.revision,
        form,
        sampled: false,
      });
      expect(own.referenceStatus).toBe('confirmed');
      await writeFile(
        join(f.dataset, 'dev/f01/labels.json'),
        JSON.stringify(collectionOf()),
      );
      expect((await workspace.bootstrap()).points[0]).toMatchObject({
        status: 'confirmed',
        referenceStatus: 'none',
      });
      const restarted = await AnnotationWorkspace.open(scope);
      expect((await restarted.bootstrap()).points[0]?.referenceStatus).toBe(
        'none',
      );
      expect((await restarted.point(token)).form).toEqual(form);
    });
  });
  test('assisted reports reuse shared N/K, missing/evidence vetoes and consensus draft; rebase changes only the public view identity', async () => {
    await withWorkflowAnnotation(async (f) => {
      const keys = f.batch.models.map((model) => model.modelKey);
      await importWorkflowOpinions({
        ...f,
        returned: returns(f.batch, {}, keys.slice(0, 2)),
        write: true,
      });
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
      const missing = await workspace.opinions(token);
      expect(missing.consensus).toMatchObject({
        n: 3,
        k: 2,
        missing: 1,
        draft: null,
      });
      expect(missing.consensus.reasons).toContain('incomplete-opinions');
      await importWorkflowOpinions({
        ...f,
        returned: returns(f.batch, {}, keys.slice(2)),
        write: true,
      });
      const complete = await workspace.opinions(token);
      expect(complete.consensus).toMatchObject({
        n: 3,
        k: 3,
        reasons: [],
        draft: { pairs: '3,10', behaviour: 'allow', evidence: form.evidence },
      });
      expect(complete.viewToken).toBe(point.viewToken);
      const now = workflowRecords(await workflowState(f.dataset, 'dev', 'f01'));
      const invalidEvidence = opinionReport(
        f.batch,
        now.opinions.map((opinion) =>
          opinion.opinion.reviewId ===
          complete.opinions.find((value) => value.complete)?.id
            ? {
                ...opinion,
                evidence: [
                  {
                    kind: 'material-quote',
                    ref: 'UNREACHABLE_EVIDENCE_SENTINEL',
                  },
                ],
              }
            : opinion,
        ),
      );
      expect(invalidEvidence.consensus.draft).toBeNull();
      expect(invalidEvidence.consensus.reasons).toContain(
        'incomplete-opinions',
      );
      const fourth = await exportWorkflowBatch({
        root: f.root,
        dataset: f.dataset,
        split: 'dev',
        group: 'f01',
        models: models(1, 3),
        context: DEFAULT_ANNOTATION_CONTEXT,
        out: join(f.root, 'fourth-pack'),
      });
      await importWorkflowOpinions({
        dataset: f.dataset,
        baseline: fourth.baseline,
        returned: returns(fourth.batch, {
          conflicts: ['Synthetic permission evidence conflict'],
        }),
        write: true,
      });
      const conflict = await workspace.opinions(token);
      expect(conflict.consensus.draft).toBeNull();
      expect(conflict.consensus.reasons).toContain('key-evidence-conflict');
      const rebased = await workspace.rebase(token, point.revision);
      expect(rebased.viewToken).not.toBe(complete.viewToken);
      expect((await workspace.opinions(token)).viewToken).toBe(
        rebased.viewToken,
      );
      expect(JSON.stringify(conflict)).not.toMatch(
        /responseHash|retryKey|promptFingerprint/u,
      );
    });
  });
});
