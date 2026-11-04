/** Synthetic values only; the shared producer renders, no transport is called. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const isolatedHome = await mkdtemp(join(tmpdir(), 'arbiter-rotation-home-'));
process.env['DSH_HOME'] = isolatedHome;
const { workflow } = await import('../evals/fixtures/workflow.js');
const { loadWorkflow } = await import('../evals/helpers/grouped.js');
const { workflowMaterial } = await import('../../evals/src/run/material.js');
const { buildAnnotationView } =
  await import('../../evals/src/annotation/workflow-view.js');
const { DEFAULT_CONFIG, configHash } = await import('../../src/config.js');

afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

const marker = /\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu;
const oldValue = 'synthetic-rotation-before';
const newValue = 'synthetic-rotation-after';
const config = {
  ...DEFAULT_CONFIG,
  context: {
    ...DEFAULT_CONFIG.context,
    projectRules: { ...DEFAULT_CONFIG.context.projectRules, enabled: false },
  },
};

describe('credential rotation through real production and annotation materials', () => {
  test.each(['chat', 'decision'] as const)(
    '%s discovers visible old/new fields before later actions and keeps future secrets out',
    async (protocol) => {
      const original = workflow();
      const root = {
        ...original,
        events: original.events.map((event) => {
          if (event.eventId === 'scan-result' && event.kind === 'result')
            return {
              ...event,
              body: {
                state: 'present' as const,
                content: {
                  count: 4,
                  path: '/tmp/rotation-check',
                  nested: { previousApiKey: oldValue, apiKey: newValue },
                  oldEcho: oldValue,
                },
              },
            };
          if (event.eventId === 'clean-call' && event.kind === 'call')
            return {
              ...event,
              tool: 'auth.activate',
              arguments: { apiKey: newValue },
            };
          return event;
        }),
      };
      const source = await loadWorkflow(root, {}, { references: false });
      expect(source.problems).toEqual([]);
      const options = {
        config,
        configRevision: configHash(config),
        projectRules: null,
      };
      const material = await workflowMaterial(
        source,
        root.rootId,
        'format-clean',
        protocol,
        options,
      );
      const annotation = await buildAnnotationView(
        source,
        root.rootId,
        'format-clean',
        {
          protocol,
          targetInputTokens: 6000,
          maxInputTokens: 10000,
          customRules: '',
          projectRules: null,
          projectRulesEnabled: false,
        },
      );
      expect(annotation.request).toEqual(material.request);
      const wire = JSON.stringify(material.request);
      expect(wire).not.toContain(oldValue);
      expect(wire).not.toContain(newValue);
      expect(new Set(wire.match(marker)).size).toBe(2);
      expect(wire).toContain('/tmp/rotation-check');
      expect(wire).toContain('previousApiKey');
      expect(material.material.blockingGaps).toEqual([]);

      const future = {
        ...root,
        events: root.events.map((event) =>
          event.eventId === 'build-call' && event.kind === 'call'
            ? {
                ...event,
                arguments: {
                  apiKey: oldValue,
                  password: 'future-only-rotation-value',
                },
              }
            : event,
        ),
      };
      const futureSource = await loadWorkflow(
        future,
        {},
        { references: false },
      );
      expect(futureSource.problems).toEqual([]);
      const current = await workflowMaterial(
        futureSource,
        root.rootId,
        'format-clean',
        protocol,
        options,
      );
      expect(current.request).toEqual(material.request);
      expect(JSON.stringify(current.request)).not.toContain(
        'future-only-rotation-value',
      );
    },
  );
});
