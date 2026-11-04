import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as service from '../../src/reviewer/service.js';
import { PRODUCTION_PACKAGE } from '../../src/reviewer/package.js';
import { defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { prepareComparison } from '../../evals/src/report/compare.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { caseMaterial } from '../../evals/src/run/material.js';
import { runCell } from '../../evals/src/run/execute.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { reviewCase } from '../evals/fixtures/documents.js';
import {
  runPlan,
  withArea,
  REPOSITORY_ROOT,
  VERSIONS,
} from '../evals/helpers/report-run.js';
import {
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from '../evals/helpers/run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';

describe(
  'unknown material and terminal states in version comparison',
  { timeout: 60_000 },
  () => {
    it('retains two actual legacy unsupported cells without inventing input changes', async () => {
      await withArea(async (area) => {
        const plan = planOf({
          protocols: ['decision'],
          targets: [chatTarget()],
        });
        const baseline = await runPlan({
          directory: join(area.path, 'baseline'),
          plan,
          fixture: fixtureOf({}),
        });
        const current = await runPlan({
          directory: join(area.path, 'current'),
          plan,
          fixture: fixtureOf({}),
        });
        const settings = defaultSettings(REPOSITORY_ROOT);
        const read = await observeRun({
          directory: current,
          root: REPOSITORY_ROOT,
          dataset: settings.dataset,
        });
        if (!read.ok) throw new Error(read.problems.join('; '));
        const result = await prepareComparison({
          settings,
          current: read.observation,
          command: {
            directory: current,
            compare: baseline,
            output: null,
            dataset: null,
            mode: 'ask',
            channel: 'available',
            force: false,
          },
        });
        expect(result?.comparison).toMatchObject({
          pairedConditions: 0,
          baseline: { cellsPlanned: 1, statuses: { unsupported: 1 } },
          current: { cellsPlanned: 1, statuses: { unsupported: 1 } },
          behaviour: { paired: 0 },
          scoring: { paired: 0 },
        });
        expect(result?.comparison.rows[0]?.reasons).not.toContain(
          'input-changed',
        );
        expect(result?.comparison.rows[0]?.conditionChanges).not.toContain(
          'source-input',
        );
        expect(result?.comparison.baseline.cells[0]?.inputHash).toBeNull();
        expect(result?.comparison.current.cells[0]?.inputHash).toBeNull();
      });
    });
    it.each(['timeout', 'cancelled'] as const)(
      'proves the actual producer can retain a scored response under late %s',
      async (status) => {
        const stopped = new AbortController(),
          actual = service.reviewWith;
        const intercept = vi
          .spyOn(service, 'reviewWith')
          .mockImplementation((pkg) => async (options) => {
            const result = await actual(pkg)(options);
            stopped.abort();
            return result;
          });
        try {
          const entry = reviewCase();
          const material = caseMaterial(entry, 'chat', {
            maxInputTokens: 10000,
            pkg: PRODUCTION_PACKAGE,
          });
          const { record } = await runCell({
            cellId: 'late-terminal',
            material,
            deps: {
              runId: 'synthetic-late-terminal',
              caseEntry: entry,
              target: chatTarget(),
              protocol: 'chat',
              repeat: 1,
              transport: 'offline',
              fixture: fixtureCell({ chat: [chatAnswer(2, 10)] }),
              versions: VERSIONS,
              llm: null,
              readCredential: () => {
                throw new Error('offline fixture cannot resolve credentials');
              },
              signal: stopped.signal,
              timedOut: () => status === 'timeout' && stopped.signal.aborted,
              now: () => 0,
              maxInputTokens: 10000,
              pkg: PRODUCTION_PACKAGE,
            },
          });
          expect(record.status).toBe(status);
          expect(record.outcome?.status).toBe('scored');
          expect(record.attempts[0]?.responseText).toContain('risk');
        } finally {
          intercept.mockRestore();
        }
      },
    );
    it.each(['timeout', 'cancelled'] as const)(
      'keeps a retained scored %s outcome out of both paired quality denominators',
      async (status) => {
        await withWorkflowArea(async (area) => {
          if (area.plan.workflow === undefined)
            throw new Error('workflow missing');
          const plan = {
            ...area.plan,
            workflow: {
              ...area.plan.workflow,
              points: area.plan.workflow.points.slice(0, 1),
            },
          };
          const baseline = await savedRun(area, 'baseline', plan),
            current = await savedRun(area, 'current', plan);
          const refs = await syntheticReferences(area, 'refs', plan);
          const read = await readRun(baseline, await compileRunCheckers(), {
            allowWorkflow: true,
          });
          if (!read.ok) throw new Error('fixture run unreadable');
          const record = read.artifact.records[0],
            state = read.artifact.index.cells[0];
          if (record === undefined || state === undefined)
            throw new Error('fixture cell missing');
          const originalResponse = record.attempts[0]?.responseText;
          await writeFile(
            join(baseline, state.record),
            JSON.stringify({
              ...record,
              status,
              stopReason: `synthetic late ${status}`,
            }),
          );
          await writeFile(
            join(baseline, 'index.json'),
            JSON.stringify({
              ...read.artifact.index,
              status: status === 'timeout' ? 'in-flight-timeout' : 'cancelled',
              cells: [
                { ...state, status, stopReason: `synthetic late ${status}` },
              ],
            }),
          );
          const result = await compared(area, baseline, current, refs);
          expect(result.exit).toBe(0);
          expect(result.section).toMatchObject({
            pairedConditions: 0,
            baseline: { cellsPlanned: 1, statuses: { [status]: 1 } },
            behaviour: { paired: 0 },
            scoring: { paired: 0 },
          });
          expect(result.section.baseline.cells[0]).toMatchObject({
            indexStatus: status,
            completed: false,
            common: { behaviour: 'allow' },
          });
          expect(result.section.rows[0]?.reasons).toContain(
            'baseline-evidence-unverified',
          );
          const retained: unknown = JSON.parse(
            await readFile(join(baseline, state.record), 'utf8'),
          );
          expect(retained).toMatchObject({
            outcome: record.outcome,
            attempts: record.attempts,
          });
          expect(originalResponse).toBeTruthy();
        });
      },
    );
  },
);
