import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';
import { withDataset } from '../evals/helpers/dataset.js';
import type { WebForm } from '../../evals/src/annotation/web-types.js';

const isolatedHome = await mkdtemp(join(tmpdir(), 'arbiter-web-home-'));
process.env['DSH_HOME'] = isolatedHome;
const { AnnotationWorkspace } =
  await import('../../evals/src/annotation/web-workspace.js');
const { startAnnotationServer } =
  await import('../../evals/src/annotation/web-server.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { readJson, workflowState, workflowRecords } =
  await import('../../evals/src/annotation/workflow-store.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
const { importWorkflowHuman, importWorkflowOpinions } =
  await import('../../evals/src/annotation/workflow-service.js');
afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});
const form: WebForm = {
  pairs: '3,10\n4,9',
  behaviour: 'deny',
  rationale: 'Synthetic engineering fixture, not human adjudication',
  evidence: '可以清理生成目录 build/；保留 assets/。',
  author: 'synthetic-tester',
  state: 'confirmed',
};
describe(
  'local annotation web real-file boundaries',
  { timeout: 30_000 },
  () => {
    test('blind startup, draft, restart and explicit single-point confirmation never read poison opinions', async () => {
      await withDataset(async (f) => {
        await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
        const poison = 'OPINIONS_MUST_NOT_BE_READ { invalid JSON';
        await writeFile(join(f.path, 'data/dev/f01/opinions.json'), poison);
        const scope = {
          root: f.path,
          dataset: join(f.path, 'data'),
          split: 'dev' as const,
          group: 'f01',
          mode: 'blind' as const,
          context: DEFAULT_ANNOTATION_CONTEXT,
        };
        const first = await AnnotationWorkspace.open(scope);
        const list = await first.bootstrap();
        expect(list.points).toHaveLength(3);
        const token = list.points[0]?.token;
        if (token === undefined) throw new Error('fixture');
        const point = await first.point(token);
        expect(point.preparation).toBe('ready');
        for (const hidden of [
          'AUTHOR_SENTINEL',
          'FUTURE_FAILURE_SENTINEL',
          'format-clean',
          'format-build',
          'OPINIONS_MUST_NOT_BE_READ',
          'retryKey',
          'promptFingerprint',
        ])
          expect(JSON.stringify(point)).not.toContain(hidden);
        const saved = await first.save({
          token,
          revision: point.revision,
          form,
          sampled: true,
        });
        await expect(
          readFile(join(f.path, 'data/dev/f01/labels.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        const second = await AnnotationWorkspace.open(scope);
        const restored = await second.point(token);
        expect(restored.form).toEqual(form);
        expect(restored.status).toBe('draft');
        expect(restored.sampled).toBe(true);
        const confirmed = await second.confirm({
          token,
          revision: saved.revision,
          form,
          sampled: true,
        });
        expect(confirmed.status).toBe('confirmed');
        const records = workflowRecords(
          await workflowState(scope.dataset, 'dev', 'f01', true),
        );
        expect(records.labels).toHaveLength(1);
        expect(records.labels[0]).toMatchObject({
          humanConfirmed: true,
          target: {
            allowedPairs: [
              [3, 10],
              [4, 9],
            ],
            behaviourReference: 'deny',
          },
        });
        expect(
          await readFile(join(f.path, 'data/dev/f01/opinions.json'), 'utf8'),
        ).toBe(poison);
        await expect(second.opinions(token)).rejects.toThrow(/blind/u);
        const batchFiles = (await readdir(second.directory)).filter((file) =>
          /^[a-f0-9-]{36}\.json$/u.test(file),
        );
        const batchPath = join(second.directory, batchFiles[0] ?? 'missing');
        const batch = await readWorkflowBatch(batchPath);
        expect(batch).toMatchObject({
          purpose: 'human',
          models: [],
          opinions: [],
        });
        expect(batch.retryKey).toBeUndefined();
        await expect(
          importWorkflowOpinions({
            dataset: scope.dataset,
            baseline: batchPath,
            returned: { batchId: batch.batchId, responses: [] },
            write: true,
          }),
        ).rejects.toThrow(/human-only/u);
      });
    });
    test('current-view, external human and raw-draft conflicts preserve the draft; irrelevant future/format changes do not block', async () => {
      await withDataset(async (f) => {
        const source = workflow();
        await f.write('data/dev/f01/workflows.json', collectionOf(source));
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
        const saved = await workspace.save({
          token,
          revision: opened.revision,
          form,
          sampled: false,
        });
        const future = {
          ...source,
          notes: 'unrelated author formatting',
          events: source.events.map((event) =>
            event.eventId === 'build-result'
              ? {
                  ...event,
                  body: {
                    state: 'present' as const,
                    content: 'CHANGED_FUTURE_SENTINEL',
                  },
                }
              : event,
          ),
        };
        await f.write('data/dev/f01/workflows.json', collectionOf(future));
        const stillValid = await workspace.save({
          token,
          revision: saved.revision,
          form,
          sampled: false,
        });
        expect(stillValid.request).toEqual(opened.request);
        const batchFile = (await readdir(workspace.directory)).find((file) =>
          /^[a-f0-9-]{36}\.json$/u.test(file),
        );
        const baseline = join(workspace.directory, batchFile ?? 'missing');
        const batch = await readWorkflowBatch(baseline);
        await writeFile(
          join(f.path, 'external-batch.json'),
          await readFile(baseline),
        );
        await importWorkflowHuman({
          dataset: scope.dataset,
          baseline: join(f.path, 'external-batch.json'),
          write: true,
          fill: {
            batchId: batch.batchId,
            decisions: [
              {
                questionId: token,
                state: 'needs-review',
                target: {
                  status: 'pending',
                  allowed: { risk: null, authorization: null },
                  behaviourReference: null,
                  rationale: 'external synthetic review',
                  decidedBy: 'other-tester',
                  decidedAt: '2026-11-02',
                },
              },
            ],
          },
        });
        await expect(
          workspace.save({
            token,
            revision: stillValid.revision,
            form,
            sampled: false,
          }),
        ).rejects.toThrow(/human decision changed/u);
        const rebased = await workspace.rebase(token, stillValid.revision);
        expect(rebased.form).toEqual(form);
        await f.write(
          'data/dev/f01/workflows.json',
          collectionOf({
            ...future,
            events: future.events.map((event) =>
              event.eventId === 'request' && event.kind === 'message'
                ? { ...event, content: 'VISIBLE_SOURCE_CHANGED' }
                : event,
            ),
          }),
        );
        await expect(
          workspace.save({
            token,
            revision: rebased.revision,
            form,
            sampled: false,
          }),
        ).rejects.toThrow(/material changed/u);
        const failed = await workspace.point(token);
        expect(failed.request).toBeNull();
        expect(failed.form).toEqual(form);
        const external: unknown = await readJson(workspace.path);
        if (external === null || typeof external !== 'object')
          throw new Error('fixture');
        await writeFile(
          workspace.path,
          JSON.stringify({ ...external, current: null }),
        );
        await expect(workspace.bootstrap()).rejects.toThrow(
          /changed externally/u,
        );
      });
    });
    test('failed material stays visible, cannot confirm, and does not hide successful points', async () => {
      await withDataset(async (f) => {
        const source = workflow();
        const events = source.events.map((event) =>
          event.kind === 'call' && event.eventId === 'build-call'
            ? { ...event, arguments: { command: 'x'.repeat(100_000) } }
            : event,
        );
        await f.write(
          'data/dev/f01/workflows.json',
          collectionOf({ ...source, events }),
        );
        const scope = {
          root: f.path,
          dataset: join(f.path, 'data'),
          split: 'dev' as const,
          group: 'f01',
          mode: 'blind' as const,
          context: {
            ...DEFAULT_ANNOTATION_CONTEXT,
            targetInputTokens: 1,
            maxInputTokens: 2900,
          },
        };
        const workspace = await AnnotationWorkspace.open(scope);
        const list = (await workspace.bootstrap()).points;
        expect(list).toHaveLength(3);
        const good = list[0]?.token,
          bad = list[1]?.token;
        if (good === undefined || bad === undefined) throw new Error('fixture');
        const failure = await workspace.point(bad);
        expect(failure).toMatchObject({
          preparation: 'preparation-failed',
          request: null,
        });
        expect(JSON.stringify(failure)).not.toMatch(
          /AUTHOR_SENTINEL|FUTURE_FAILURE_SENTINEL|x{100}/u,
        );
        await expect(
          workspace.confirm({
            token: bad,
            revision: failure.revision,
            form,
            sampled: false,
          }),
        ).rejects.toThrow(/prepared baseline/u);
        const ready = await workspace.point(good);
        expect(ready.preparation).toBe('ready');
        expect(
          (
            await workspace.save({
              token: good,
              revision: ready.revision,
              form,
              sampled: false,
            })
          ).status,
        ).toBe('draft');
        const allFailed = await AnnotationWorkspace.open({
          ...scope,
          context: {
            ...scope.context,
            targetInputTokens: 1,
            maxInputTokens: 1,
          },
        });
        for (const item of (await allFailed.bootstrap()).points)
          expect((await allFailed.point(item.token)).preparation).toBe(
            'preparation-failed',
          );
        expect((await allFailed.bootstrap()).points).toHaveLength(3);
      });
    });
    test('real HTTP rejects cross-origin writes, missing tokens, multi-point bodies, paths and blind opinions', async () => {
      await withDataset(async (f) => {
        await f.write('data/dev/f01/workflows.json', collectionOf(workflow()));
        await mkdir(join(f.path, 'data/holdout'), { recursive: true });
        const service = await startAnnotationServer({
          root: f.path,
          dataset: join(f.path, 'data'),
          split: 'dev',
          group: 'f01',
          mode: 'blind',
          context: DEFAULT_ANNOTATION_CONTEXT,
        });
        const url = new URL(service.url),
          headers = {
            'x-annotation-token': url.hash.slice(1),
            'content-type': 'application/json',
          };
        try {
          expect(url.hostname).toBe('127.0.0.1');
          const html = await (await fetch(url.origin)).text();
          expect(html).toContain('/app.js');
          expect(html).not.toContain('AUTHOR_SENTINEL');
          const script = await fetch(`${url.origin}/app.js`);
          expect(script.status).toBe(200);
          expect(script.headers.get('content-security-policy')).toContain(
            "script-src 'self'",
          );
          expect((await fetch(`${url.origin}/api/bootstrap`)).status).toBe(403);
          expect(
            (
              await fetch(`${url.origin}/api/bootstrap`, {
                headers: { ...headers, origin: 'https://evil.example' },
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await fetch(`${url.origin}/api/confirm`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ decisions: [] }),
              })
            ).status,
          ).toBe(400);
          expect(
            (
              await fetch(`${url.origin}/api/point`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ token: '../../holdout' }),
              })
            ).status,
          ).toBe(400);
          const token = (await service.workspace.bootstrap()).points[0]?.token;
          const denied = await fetch(`${url.origin}/api/opinions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ token }),
          });
          expect(denied.status).toBe(400);
          expect(await denied.text()).not.toContain('opinions.json');
        } finally {
          await service.close();
        }
        await expect(fetch(url.origin)).rejects.toThrow();
        const failedService = await startAnnotationServer({
          root: f.path,
          dataset: join(f.path, 'data'),
          split: 'dev',
          group: 'f01',
          mode: 'blind',
          context: {
            ...DEFAULT_ANNOTATION_CONTEXT,
            targetInputTokens: 1,
            maxInputTokens: 1,
          },
        });
        try {
          const failedUrl = new URL(failedService.url);
          const failedToken = (await failedService.workspace.bootstrap())
            .points[0]?.token;
          const failedResponse = await fetch(`${failedUrl.origin}/api/point`, {
            method: 'POST',
            headers: {
              'x-annotation-token': failedUrl.hash.slice(1),
              'content-type': 'application/json',
            },
            body: JSON.stringify({ token: failedToken }),
          });
          expect(failedResponse.status).toBe(200);
          const raw = await failedResponse.text();
          expect(JSON.parse(raw)).toMatchObject({
            preparation: 'preparation-failed',
            request: null,
            status: 'preparation-failed',
          });
          expect(raw).not.toMatch(
            /AUTHOR_SENTINEL|FUTURE_FAILURE_SENTINEL|format-build|format-clean/u,
          );
        } finally {
          await failedService.close();
        }
      });
    });
  },
);
