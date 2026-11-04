/** Synthetic material only; no provider call or real annotation. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import type { AnnotationContext } from '../../evals/src/data/annotation-types.js';

const isolatedHome = await mkdtemp(join(tmpdir(), 'arbiter-rules-home-'));
process.env['DSH_HOME'] = isolatedHome;
const { withWorkflowArea } = await import('../evals/helpers/workflow-run.js');
const { loadWorkflowSources, sourceMaterial } =
  await import('../../evals/src/run/source.js');
const { buildAnnotationView, DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { annotationBindingOf } =
  await import('../../evals/src/annotation/workflow-binding.js');
const { sameAnnotationView } =
  await import('../../evals/src/data/annotation-binding.js');
const { PRODUCTION_PACKAGE } = await import('../../src/reviewer/package.js');
const { REVIEW_CONTRACT_VERSION } =
  await import('../../src/review-contract/index.js');
const { DEFAULT_CONFIG } = await import('../../src/config.js');
const { legacyMetadata } =
  await import('../../evals/src/data/legacy-metadata.js');
afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

describe('annotation project rules match the formal runner', () => {
  test.each(['chat', 'decision'] as const)(
    '%s preserves legacy absence and matches explicit disabled/provided material',
    async (protocol) => {
      await withWorkflowArea(async (area) => {
        if (area.plan.workflow === undefined) throw new Error('fixture plan');
        const base = {
          ...DEFAULT_ANNOTATION_CONTEXT,
          protocol,
          targetInputTokens: 6000,
          maxInputTokens: 10000,
        };
        const loaded = await loadWorkflowSources(area.root, area.plan);
        const source = loaded.cases[0];
        if (source === undefined || !('kind' in source))
          throw new Error('fixture source');
        const build = (context: AnnotationContext) =>
          buildAnnotationView(
            source.dataset,
            source.workflow.rootId,
            source.workflow.pointId,
            context,
          );
        const legacy = await build(base);
        const enabled = await build({ ...base, projectRulesEnabled: true });
        expect(legacy).toEqual(enabled);
        const disabled = await build({ ...base, projectRulesEnabled: false });
        const rules = 'Synthetic standing rule: keep assets/.';
        const provided = await build({
          ...base,
          projectRules: rules,
          projectRulesEnabled: true,
        });
        expect(await build({ ...base, projectRules: rules })).toEqual(provided);
        expect(sameAnnotationView(legacy.binding, disabled.binding)).toBe(
          false,
        );
        expect(sameAnnotationView(provided.binding, disabled.binding)).toBe(
          false,
        );
        const versions = (await legacyMetadata()).versions;
        for (const [input, expected] of [
          [{ kind: 'disabled' as const }, disabled],
          [{ kind: 'provided' as const, text: rules }, provided],
        ] as const) {
          const material = await sourceMaterial(source, protocol, {
            ...area.plan,
            workflow: {
              ...area.plan.workflow,
              input: { customRules: '', projectRules: input },
            },
          });
          const binding = annotationBindingOf({
            material,
            protocol,
            pkg: PRODUCTION_PACKAGE,
            versions: {
              contract: REVIEW_CONTRACT_VERSION,
              rubric: versions.rubric,
              policy: DEFAULT_CONFIG.policy.version,
            },
          });
          expect(sameAnnotationView(expected.binding, binding)).toBe(true);
        }
        expect(JSON.stringify(disabled.request)).not.toContain(
          'FUTURE_FAILURE_SENTINEL',
        );
        expect(JSON.stringify(disabled.request)).not.toContain(
          'AUTHOR_SENTINEL',
        );
        expect(JSON.stringify(provided.request)).toContain(rules);
        expect(JSON.stringify(disabled.request)).not.toContain(rules);
      });
    },
    30_000,
  );
  test('explicit disabled keeps the shared truncation and hard-budget gates', async () => {
    await withWorkflowArea(async (area) => {
      const loaded = await loadWorkflowSources(area.root, area.plan);
      const source = loaded.cases[0];
      if (source === undefined || !('kind' in source))
        throw new Error('fixture source');
      const context = {
        ...DEFAULT_ANNOTATION_CONTEXT,
        projectRulesEnabled: false,
        targetInputTokens: 1,
        maxInputTokens: 10000,
      };
      const view = await buildAnnotationView(
        source.dataset,
        source.workflow.rootId,
        source.workflow.pointId,
        context,
      );
      const material = await sourceMaterial(source, context.protocol, {
        ...area.plan,
        context: { targetInputTokens: 1, maxInputTokens: 10000 },
      });
      expect(material.snapshot.budget.targetInputTokens).toBe(1);
      expect(
        sameAnnotationView(
          view.binding,
          annotationBindingOf({
            material,
            protocol: context.protocol,
            pkg: PRODUCTION_PACKAGE,
            versions: view.binding.versions,
          }),
        ),
      ).toBe(true);
      await expect(
        buildAnnotationView(
          source.dataset,
          source.workflow.rootId,
          source.workflow.pointId,
          { ...context, maxInputTokens: 1 },
        ),
      ).rejects.toThrow(/OVER_BUDGET/u);
    });
  }, 30_000);
});
