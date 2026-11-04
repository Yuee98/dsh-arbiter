/** Real on-disk exchange over synthetic fixtures, never a model/human opinion. */
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { AnnotationContext } from '../../evals/src/data/annotation-types.js';

const isolatedHome = await mkdtemp(join(tmpdir(), 'arbiter-rules-exchange-'));
process.env['DSH_HOME'] = isolatedHome;
const { withWorkflowArea } = await import('../evals/helpers/workflow-run.js');
const { collectionOf } = await import('../evals/fixtures/workflow.js');
const { models, returns } =
  await import('../evals/helpers/workflow-annotation.js');
const { runWorkflowAnnotationCli } =
  await import('../../evals/src/annotation/workflow-command.js');
const { readWorkflowBatch } =
  await import('../../evals/src/annotation/workflow-batch-read.js');
const { DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { importWorkflowOpinions, workflowReferences } =
  await import('../../evals/src/annotation/workflow-service.js');
const { workflowRecords, workflowState } =
  await import('../../evals/src/annotation/workflow-store.js');
const { readReferenceSnapshot, frozenReferenceFor } =
  await import('../../evals/src/metrics/reference-snapshot.js');
const { loadWorkflowSources, sourceMaterial } =
  await import('../../evals/src/run/source.js');
const { annotationBindingOf } =
  await import('../../evals/src/annotation/workflow-binding.js');
const { PRODUCTION_PACKAGE } = await import('../../src/reviewer/package.js');
const { AnnotationWorkspace } =
  await import('../../evals/src/annotation/web-workspace.js');
afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

describe('explicit rule state crosses real exchange boundaries', () => {
  test.each([false, true])(
    'enabled=%s survives CLI, batch, opinions, snapshot and web reconstruction',
    async (enabled) => {
      await withWorkflowArea(async (area) => {
        if (area.plan.workflow === undefined) throw new Error('fixture plan');
        await writeFile(
          area.sourcePath,
          JSON.stringify(
            collectionOf({
              ...area.source,
              events: area.source.events.map((event) =>
                event.kind === 'message' && event.eventId === 'request'
                  ? {
                      ...event,
                      content: `password=synthetic-source-secret; ${event.content}`,
                    }
                  : event,
              ),
            }),
          ),
        );
        const context: AnnotationContext = {
          ...DEFAULT_ANNOTATION_CONTEXT,
          targetInputTokens: 6000,
          maxInputTokens: 10000,
          projectRulesEnabled: enabled,
          projectRules: enabled
            ? 'Synthetic standing rule: keep assets/.'
            : null,
        };
        const contextPath = join(area.directory, 'context.json');
        const modelsPath = join(area.directory, 'models.json');
        await writeFile(contextPath, JSON.stringify(context));
        await writeFile(modelsPath, JSON.stringify(models(3)));
        const out: string[] = [],
          err: string[] = [];
        const io = {
          root: area.directory,
          out: (line: string) => out.push(line),
          err: (line: string) => err.push(line),
        };
        expect(
          await runWorkflowAnnotationCli(
            [
              'workflow-export',
              area.datasetPath,
              '--group',
              'f01',
              '--models',
              modelsPath,
              '--context',
              contextPath,
              '--out',
              'pack',
            ],
            io,
          ),
        ).toBe(0);
        expect(err).toEqual([]);
        const baseline = /baseline (.+)$/u.exec(out[0] ?? '')?.[1];
        if (baseline === undefined) throw new Error('missing baseline');
        const batch = await readWorkflowBatch(baseline);
        expect(batch.context).toEqual(context);
        expect(JSON.stringify(batch)).not.toContain('synthetic-source-secret');
        expect(JSON.stringify(batch.points[0]?.request)).not.toContain(
          'FUTURE_FAILURE_SENTINEL',
        );
        expect(
          batch.points.every(
            (point) => point.binding !== null && point.error === null,
          ),
        ).toBe(true);
        const point = batch.points[0];
        if (point?.binding === undefined || point.binding === null)
          throw new Error('fixture binding');
        const answersPath = join(area.directory, 'answers.json');
        await writeFile(
          answersPath,
          JSON.stringify(
            returns(batch, {
              rationale:
                'Synthetic result with password=synthetic-response-secret',
            }),
          ),
        );
        expect(
          await runWorkflowAnnotationCli(
            [
              'workflow-import',
              area.datasetPath,
              '--batch',
              baseline,
              '--answers',
              answersPath,
              '--write',
            ],
            io,
          ),
        ).toBe(0);
        expect(err).toEqual([]);
        const reloaded = await readWorkflowBatch(baseline);
        expect(reloaded.context).toEqual(context);
        expect(
          await readFile(
            join(area.datasetPath, 'dev/f01/opinions.json'),
            'utf8',
          ),
        ).not.toContain('synthetic-response-secret');
        const opinions = workflowRecords(
          await workflowState(area.datasetPath, 'dev', 'f01'),
        ).opinions;
        expect(
          opinions.filter((opinion) => !opinion.annotation?.registration),
        ).toHaveLength(3);
        expect(
          opinions.every(
            (opinion) =>
              JSON.stringify(opinion.annotation?.context) ===
              JSON.stringify(context),
          ),
        ).toBe(true);
        const snapshot = await workflowReferences({
          root: area.directory,
          dataset: area.datasetPath,
          split: 'dev',
          group: 'f01',
          context,
        });
        const snapshotPath = join(area.directory, 'references.json');
        await writeFile(snapshotPath, JSON.stringify(snapshot));
        const frozen = await readReferenceSnapshot(snapshotPath);
        expect(frozen.context).toEqual(context);
        expect(frozen.entries[0]?.source).toBe('model-consensus');
        const loaded = await loadWorkflowSources(area.root, area.plan);
        const source = loaded.cases[0];
        if (source === undefined) throw new Error('fixture source');
        for (const matching of [true, false]) {
          const rules = (matching ? enabled : !enabled)
            ? {
                kind: 'provided' as const,
                text: context.projectRules ?? 'Synthetic alternate rule.',
              }
            : { kind: 'disabled' as const };
          const material = await sourceMaterial(source, context.protocol, {
            ...area.plan,
            workflow: {
              ...area.plan.workflow,
              input: { customRules: '', projectRules: rules },
            },
          });
          const binding = annotationBindingOf({
            material,
            protocol: context.protocol,
            pkg: PRODUCTION_PACKAGE,
            versions: point.binding.versions,
          });
          const reference = frozenReferenceFor({
            snapshots: [frozen],
            rootId: point.rootId,
            pointId: point.pointId,
            viewId: point.viewId,
            split: 'dev',
            group: 'f01',
            protocol: context.protocol,
            binding,
          });
          expect(reference.source).toBe(
            matching ? 'model-consensus' : 'unresolved',
          );
        }
        const checkpoint = await readFile(baseline, 'utf8');
        const invalidContext = {
          ...context,
          projectRulesEnabled: false,
          projectRules: 'Contradictory synthetic rule.',
        };
        await writeFile(
          baseline,
          JSON.stringify({ ...reloaded, context: invalidContext }),
        );
        await expect(readWorkflowBatch(baseline)).rejects.toThrow();
        await writeFile(
          baseline,
          JSON.stringify({
            ...reloaded,
            opinions: reloaded.opinions.map((opinion) => ({
              ...opinion,
              annotation: { ...opinion.annotation, context: invalidContext },
            })),
          }),
        );
        await expect(readWorkflowBatch(baseline)).rejects.toThrow();
        await writeFile(baseline, checkpoint);
        const opposite = {
          ...context,
          projectRulesEnabled: !enabled,
          projectRules: enabled ? null : 'Synthetic alternate rule.',
        };
        const opinionsPath = join(area.datasetPath, 'dev/f01/opinions.json');
        const before = await readFile(opinionsPath, 'utf8'),
          saved = await readFile(baseline, 'utf8');
        await expect(
          importWorkflowOpinions({
            dataset: area.datasetPath,
            baseline,
            returned: returns(batch),
            write: true,
            context: opposite,
          }),
        ).rejects.toThrow(/input\/view\/contract changed/u);
        expect(await readFile(opinionsPath, 'utf8')).toBe(before);
        expect(await readFile(baseline, 'utf8')).toBe(saved);
        const scope = {
          root: area.directory,
          dataset: area.datasetPath,
          split: 'dev' as const,
          group: 'f01',
          mode: 'assisted' as const,
          context,
        };
        const web = await AnnotationWorkspace.open(scope);
        const token = (await web.bootstrap()).points[0]?.token;
        if (token === undefined) throw new Error('web token');
        const first = await web.point(token);
        expect(first.preparation).toBe('ready');
        const assisted = await web.opinions(token);
        const returnedOpinions = assisted.opinions.filter(
          (opinion) => opinion.rawResponse !== null,
        );
        expect(returnedOpinions).toHaveLength(3);
        expect(returnedOpinions.every((opinion) => opinion.complete)).toBe(
          true,
        );
        expect(JSON.stringify(assisted)).not.toContain(
          'synthetic-response-secret',
        );
        expect(assisted.consensus.valid).toBe(3);
        const restored = await AnnotationWorkspace.open(scope);
        expect((await restored.point(token)).request).toEqual(first.request);
        const humanBatches = (await readdir(web.directory)).filter(
          (name) => name !== 'draft.json' && name.endsWith('.json'),
        );
        expect(humanBatches).toHaveLength(1);
        const human = await readWorkflowBatch(
          join(web.directory, humanBatches[0] ?? ''),
        );
        expect(human.context).toEqual(context);
        expect(human.points[0]?.binding).toEqual(point.binding);
        // Old snapshots remain readable; they keep their original context and view.
        const legacy = await workflowReferences({
          root: area.directory,
          dataset: area.datasetPath,
          split: 'dev',
          group: 'f01',
          context: DEFAULT_ANNOTATION_CONTEXT,
        });
        await writeFile(snapshotPath, JSON.stringify(legacy));
        expect((await readReferenceSnapshot(snapshotPath)).context).toEqual(
          DEFAULT_ANNOTATION_CONTEXT,
        );
        await writeFile(
          snapshotPath,
          JSON.stringify({
            ...snapshot,
            context: { ...context, projectRulesEnabled: 'false' },
          }),
        );
        await expect(readReferenceSnapshot(snapshotPath)).rejects.toThrow();
      });
    },
    30_000,
  );

  test('contradictory CLI and direct web context fail before creating artifacts', async () => {
    await withWorkflowArea(async (area) => {
      const context = {
        ...DEFAULT_ANNOTATION_CONTEXT,
        projectRulesEnabled: false,
        projectRules: '',
      };
      const contextPath = join(area.directory, 'context.json');
      await writeFile(contextPath, JSON.stringify(context));
      await writeFile(
        join(area.directory, 'models.json'),
        JSON.stringify(models(3)),
      );
      const errors: string[] = [];
      expect(
        await runWorkflowAnnotationCli(
          [
            'workflow-export',
            area.datasetPath,
            '--group',
            'f01',
            '--models',
            'models.json',
            '--context',
            contextPath,
            '--out',
            'pack',
          ],
          {
            root: area.directory,
            out: () => {},
            err: (line) => errors.push(line),
          },
        ),
      ).toBe(1);
      expect(errors.join('\n')).toContain('must');
      await expect(
        AnnotationWorkspace.open({
          root: area.directory,
          dataset: area.datasetPath,
          split: 'dev',
          group: 'f01',
          mode: 'blind',
          context,
        }),
      ).rejects.toThrow();
      for (const path of ['pack', '.local'])
        await expect(access(join(area.directory, path))).rejects.toThrow();
      expect(await readdir(join(area.datasetPath, 'dev/f01'))).toEqual([
        'workflows.json',
      ]);
    });
  }, 30_000);
});
