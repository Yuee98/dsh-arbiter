import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { exportWorkflowBatch } from '../../evals/src/annotation/workflow-export.js';
import {
  importWorkflowOpinions,
  workflowReferences,
} from '../../evals/src/annotation/workflow-service.js';
import {
  DEFAULT_ANNOTATION_CONTEXT,
  buildAnnotationView,
  workflowSource,
} from '../../evals/src/annotation/workflow-view.js';
import { withDataset, REPOSITORY_ROOT } from '../evals/helpers/dataset.js';
import {
  models,
  returns,
  quote,
} from '../evals/helpers/workflow-annotation.js';
import {
  collectionOf,
  workflow,
  childWorkflow,
} from '../evals/fixtures/workflow.js';

describe('actual effective views and CLI isolation', () => {
  test('unchanged visible facts survive a provenance-only budget adjustment and preparation failures never export raw sources', async () => {
    await withDataset(async (temp) => {
      const dataset = join(temp.path, 'data');
      await temp.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const source = await workflowSource(dataset, 'dev', 'f01');
      const first = await buildAnnotationView(
        source,
        'format-build',
        'format-clean',
        DEFAULT_ANNOTATION_CONTEXT,
      );
      const second = await buildAnnotationView(
        source,
        'format-build',
        'format-clean',
        { ...DEFAULT_ANNOTATION_CONTEXT, targetInputTokens: 6001 },
      );
      expect(first.request).not.toEqual(second.request);
      expect(first.binding.promptFingerprint).toBe(
        second.binding.promptFingerprint,
      );
      const context = {
        ...DEFAULT_ANNOTATION_CONTEXT,
        targetInputTokens: 1,
        maxInputTokens: 1,
      };
      const failed = await exportWorkflowBatch({
        root: temp.path,
        dataset,
        split: 'dev',
        group: 'f01',
        models: models(3),
        context,
        out: join(temp.path, 'failed'),
      });
      expect(
        failed.batch.points.every(
          (point) =>
            point.binding === null &&
            point.request === null &&
            point.error !== null,
        ),
      ).toBe(true);
      const snapshot = await workflowReferences({
        dataset,
        split: 'dev',
        group: 'f01',
        context,
      });
      expect(snapshot.entries).toHaveLength(3);
      expect(
        snapshot.entries.every(
          (entry) => entry.source === 'unresolved' && entry.request === null,
        ),
      ).toBe(true);
      await expect(
        workflowReferences({
          dataset,
          split: 'dev',
          group: 'f01',
          context: {
            ...DEFAULT_ANNOTATION_CONTEXT,
            customRules: 'password=synthetic-context-secret',
          },
        }),
      ).rejects.toThrow(/without credential/u);
    });
  }, 30_000);
  test('omitted tool text changes prebudget input but leaves an applicable reference', async () => {
    await withDataset(async (temp) => {
      const dataset = join(temp.path, 'data'),
        file = 'data/dev/f01/workflows.json';
      const context = { ...DEFAULT_ANNOTATION_CONTEXT, targetInputTokens: 1 };
      await temp.write(file, collectionOf(workflow()));
      const f = await exportWorkflowBatch({
        root: temp.path,
        dataset,
        split: 'dev',
        group: 'f01',
        models: models(3),
        context,
        out: join(temp.path, 'pack'),
      });
      const first = f.batch.points[0];
      if (first?.binding === undefined || first.binding === null)
        throw new Error('fixture preparation failed');
      await temp.write(
        file,
        collectionOf(
          workflow({
            events: workflow().events.map((event) =>
              event.eventId === 'scan-result' && event.kind === 'result'
                ? {
                    ...event,
                    body: {
                      state: 'present',
                      content: 'unselected alternate ordinary text',
                    },
                  }
                : event,
            ),
          }),
        ),
      );
      const built = await buildAnnotationView(
        await workflowSource(dataset, 'dev', 'f01'),
        first.rootId,
        first.pointId,
        context,
      );
      expect(built.binding.inputHash).not.toBe(first.binding.inputHash);
      expect(built.binding.promptFingerprint).toBe(
        first.binding.promptFingerprint,
      );
      await importWorkflowOpinions({
        dataset,
        baseline: f.baseline,
        returned: returns(f.batch),
        write: true,
      });
      expect(
        (
          await workflowReferences({
            dataset,
            split: 'dev',
            group: 'f01',
            context,
          })
        ).entries[0]?.source,
      ).toBe('model-consensus');
    });
  }, 30_000);
  test('a materially different diagnostic view creates a separate reference and does not overwrite the original', async () => {
    await withDataset(async (temp) => {
      const dataset = join(temp.path, 'data');
      await temp.write('data/dev/f01/workflows.json', collectionOf(workflow()));
      const first = await exportWorkflowBatch({
        root: temp.path,
        dataset,
        split: 'dev',
        group: 'f01',
        models: models(3),
        context: DEFAULT_ANNOTATION_CONTEXT,
        out: join(temp.path, 'first'),
      });
      await importWorkflowOpinions({
        dataset,
        baseline: first.baseline,
        returned: returns(first.batch),
        write: true,
      });
      const context = { ...DEFAULT_ANNOTATION_CONTEXT, targetInputTokens: 1 };
      const second = await exportWorkflowBatch({
        root: temp.path,
        dataset,
        split: 'dev',
        group: 'f01',
        models: models(3),
        context,
        out: join(temp.path, 'second'),
      });
      expect(second.batch.points[0]?.modelReferenceId).not.toBe(
        first.batch.points[0]?.modelReferenceId,
      );
      await importWorkflowOpinions({
        dataset,
        baseline: second.baseline,
        returned: returns(second.batch, { pairs: [[4, 9]] }),
        write: true,
      });
      expect(
        (
          await workflowReferences({
            dataset,
            split: 'dev',
            group: 'f01',
            context: DEFAULT_ANNOTATION_CONTEXT,
          })
        ).entries[0]?.reference?.target.allowedPairs,
      ).toEqual([[3, 10]]);
      expect(
        (
          await workflowReferences({
            dataset,
            split: 'dev',
            group: 'f01',
            context,
          })
        ).entries[0]?.reference?.target.allowedPairs,
      ).toEqual([[4, 9]]);
    });
  }, 30_000);
  test.each(['chat', 'decision'] as const)(
    '%s parent/child questions have one active format and only their parent cutoff',
    async (protocol) => {
      await withDataset(async (temp) => {
        const dataset = join(temp.path, 'data');
        await temp.write(
          'data/dev/f09/workflows.json',
          collectionOf(childWorkflow()),
        );
        const exported = await exportWorkflowBatch({
          root: temp.path,
          dataset,
          split: 'dev',
          group: 'f09',
          models: models(3),
          context: { ...DEFAULT_ANNOTATION_CONTEXT, protocol },
          out: join(temp.path, 'pack'),
        });
        const point = exported.batch.points[0];
        if (point === undefined) throw new Error('fixture');
        const text = await readFile(
          join(temp.path, 'pack', `${point.questionId}.json`),
          'utf8',
        );
        expect(text).not.toContain('PARENT_FUTURE_SENTINEL');
        expect(text).not.toContain('SIBLING_SENTINEL');
        expect(text).toContain('唯一有效的回答格式');
        expect(text).toContain('不是本次标注指令');
        expect(text).toContain('公开 1..10');
        expect(text).toContain('behaviourReference');
        expect(text).not.toContain('format-child');
        expect(text).not.toContain('child-first-point');
      });
    },
    30_000,
  );
  test('cross-process CLI imports a redacted view, rejects a changed credential and exposes both CLI registrations', async () => {
    await withDataset(async (temp) => {
      const dataset = join(temp.path, 'data');
      const value = (secret: string) =>
        workflow({
          events: workflow().events.map((event) =>
            event.eventId === 'request' && event.kind === 'message'
              ? { ...event, content: `password=${secret}; ${quote}` }
              : event,
          ),
        });
      await temp.write(
        'data/dev/f01/workflows.json',
        collectionOf(value('synthetic-private-one')),
      );
      const f = await exportWorkflowBatch({
        root: temp.path,
        dataset,
        split: 'dev',
        group: 'f01',
        models: models(3),
        context: DEFAULT_ANNOTATION_CONTEXT,
        out: join(temp.path, 'pack'),
      });
      expect(JSON.stringify(f.batch)).not.toContain('synthetic-private-one');
      const credentialQuote =
        /password=\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/u.exec(
          JSON.stringify(f.batch.points[0]?.request),
        )?.[0];
      if (credentialQuote === undefined)
        throw new Error('fixture credential was not redacted');
      const answers = join(temp.path, 'answers.json');
      await writeFile(
        answers,
        JSON.stringify(
          returns(f.batch, {
            evidence: [quote, credentialQuote],
            rationale:
              'Synthetic rationale with password=synthetic-response-secret',
          }),
        ),
      );
      const cli = join(REPOSITORY_ROOT, 'evals/src/cli.ts'),
        run = promisify(execFile);
      const imported = await run(
        process.execPath,
        [
          cli,
          'workflow-import',
          dataset,
          '--batch',
          f.baseline,
          '--answers',
          answers,
          '--write',
        ],
        { cwd: REPOSITORY_ROOT },
      );
      expect(imported.stdout).toContain(
        'saved 3 model responses; no human confirmation',
      );
      expect(imported.stdout + imported.stderr).not.toContain(
        'synthetic-private-one',
      );
      const viewed = await run(
        process.execPath,
        [cli, 'workflow-reference', dataset, '--group', 'f01'],
        { cwd: REPOSITORY_ROOT },
      );
      expect(viewed.stdout).toContain('model-consensus');
      expect(
        await readFile(join(dataset, 'dev/f01/opinions.json'), 'utf8'),
      ).not.toContain('synthetic-response-secret');
      await temp.write(
        'data/dev/f01/workflows.json',
        collectionOf(value('synthetic-private-two')),
      );
      await expect(
        run(
          process.execPath,
          [
            cli,
            'workflow-import',
            dataset,
            '--batch',
            f.baseline,
            '--answers',
            answers,
            '--write',
          ],
          { cwd: REPOSITORY_ROOT },
        ),
      ).rejects.toThrow(/input\/view\/contract changed/u);
      const help = await run(process.execPath, [cli, '--help'], {
        cwd: REPOSITORY_ROOT,
      });
      expect(help.stdout).toContain('workflow-export');
      expect(help.stdout).toContain('legacy annotation');
    });
  }, 30_000);
});
