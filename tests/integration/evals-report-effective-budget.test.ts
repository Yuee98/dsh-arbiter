import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';

describe(
  'publication uses the saved effective workflow budget',
  { timeout: 30_000 },
  () => {
    it.each([
      { max: 10000, requested: null, expected: 6000 },
      { max: 4000, requested: null, expected: 4000 },
      { max: 10000, requested: 3500, expected: 3500 },
    ])(
      'publishes target $expected with max $max and optional target $requested',
      async ({ max, requested, expected }) => {
        await withWorkflowArea(async (area) => {
          const plan = {
            ...area.plan,
            context: {
              maxInputTokens: max,
              ...(requested === null ? {} : { targetInputTokens: requested }),
            },
          };
          await area.write(plan);
          const prefix = join(area.directory, 'actual-budget');
          expect(
            await area.cli(['run', area.planPath, '--report', '--out', prefix]),
          ).toBe(0);
          const actual = await readRun(
            area.runDirectory,
            await compileRunCheckers(),
            { allowWorkflow: true },
          );
          if (!actual.ok) throw new Error('missing run');
          expect(
            actual.artifact.index.workflowExecution?.config,
          ).toHaveProperty('context.targetInputTokens', expected);
          const before = await readFile(
            join(area.runDirectory, 'index.json'),
            'utf8',
          );
          const report: unknown = JSON.parse(
            await readFile(`${prefix}.json`, 'utf8'),
          );
          expect(report).toHaveProperty(
            'publication.context.targetInputTokens',
            expected,
          );
          expect(report).toHaveProperty(
            'publication.context.maxInputTokens',
            max,
          );
          const rebuilt = join(area.directory, 'rebuilt-budget');
          expect(
            await area.cli(['report', area.runDirectory, '--out', rebuilt]),
          ).toBe(0);
          const saved: unknown = JSON.parse(
            await readFile(`${rebuilt}.json`, 'utf8'),
          );
          expect(saved).toHaveProperty(
            'publication.context.targetInputTokens',
            expected,
          );
          expect(
            await readFile(join(area.runDirectory, 'index.json'), 'utf8'),
          ).toBe(before);
        });
      },
    );
  },
);
