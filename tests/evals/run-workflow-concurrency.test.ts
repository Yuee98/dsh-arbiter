import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sources from '../../evals/src/run/source.js';
import * as service from '../../src/reviewer/service.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { cellGrid } from '../../evals/src/run/plan.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { withWorkflowArea } from './helpers/workflow-run.js';
import { chatTarget, chatAnswer } from './helpers/run.js';

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    promise,
    resolve: () => {
      open();
    },
  };
}

const checkers = await compileRunCheckers();
afterEach(() => vi.restoreAllMocks());

describe('ordered workflow admission, repairs and unknown attempts', () => {
  it('stops on a normally returned timeout with no attempt report before refunding its reservation', async () => {
    await withWorkflowArea(async (area) => {
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
      const actual = service.reviewWith;
      let entered = 0;
      vi.spyOn(service, 'reviewWith').mockImplementation(
        (pkg) => async (options) => {
          entered += 1;
          const result = await actual(pkg)(options);
          timeout.abort();
          return { ...result, attempts: [] };
        },
      );
      await area.write({
        ...area.plan,
        bounds: { ...area.plan.bounds, concurrency: 1 },
        resource: {
          runDirectory: area.runDirectory,
          maxAttempts: 1,
          maxEstimatedInputTokens: 10000,
        },
      });
      expect(await area.cli(['run', area.planPath])).toBe(1);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('timeout run missing');
      expect(entered).toBe(1);
      expect(read.artifact.records).toHaveLength(1);
      expect(read.artifact.index.spent.attempts).toBe(1);
      expect(read.artifact.index.status).toBe('in-flight-timeout');
    });
  });
  it('lets the slow first preparation take the last allowance before a faster later view', async () => {
    await withWorkflowArea(async (area) => {
      const started = barrier();
      const release = barrier();
      const actual = sources.sourceMaterial;
      const prepared: string[] = [];
      vi.spyOn(sources, 'sourceMaterial').mockImplementation(
        async (...args) => {
          prepared.push(args[0].caseId);
          if (args[0].caseId === 'format-clean-main') {
            started.resolve();
            await release.promise;
          }
          return actual(...args);
        },
      );
      await area.write({
        ...area.plan,
        resource: {
          runDirectory: area.runDirectory,
          maxAttempts: 1,
          maxEstimatedInputTokens: 80000,
        },
      });
      const running = area.cli(['run', area.planPath]);
      try {
        await started.promise;
        expect(prepared).toEqual(['format-clean-main']);
      } finally {
        release.resolve();
      }
      expect(await running).toBe(1);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('run missing');
      expect(read.artifact.records.map((r) => r.workflow?.pointId)).toEqual([
        'format-clean',
      ]);
    });
  });

  it('charges repair attempts against the same input ceiling and preserves the whole unknown reservation', async () => {
    await withWorkflowArea(async (area) => {
      const plan = {
        ...area.plan,
        protocols: ['chat' as const],
        targets: [chatTarget()],
        bounds: { ...area.plan.bounds, concurrency: 1 },
        resource: {
          runDirectory: area.runDirectory,
          maxAttempts: 3,
          maxEstimatedInputTokens: 30000,
        },
      };
      await area.write(plan);
      const decoded = checkers.fixture(
        JSON.parse(await readFile(area.fixturePath, 'utf8')),
      );
      if (!decoded.ok) throw new Error('fixture invalid');
      const raw = decoded.document;
      const first = cellGrid(plan).cells[0];
      if (first === undefined || raw.cells[first.cellId] === undefined)
        throw new Error('fixture cell missing');
      const entry = raw.cells[first.cellId];
      if (entry === undefined) throw new Error('fixture cell missing');
      await writeFile(
        area.fixturePath,
        JSON.stringify({
          ...raw,
          cells: {
            ...raw.cells,
            [first.cellId]: {
              ...entry,
              chat: [
                { kind: 'text', text: 'not a valid answer' },
                chatAnswer(2, 10),
              ],
            },
          },
        }),
      );
      const actual = service.reviewWith;
      let observed = 0;
      vi.spyOn(service, 'reviewWith').mockImplementation(
        (pkg) => async (options) => {
          const result = await actual(pkg)(options);
          observed += result.attempts.length;
          throw new Error('post-repair result lost');
        },
      );
      expect(await area.cli(['run', area.planPath])).toBe(1);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('run missing');
      expect(observed).toBe(2);
      expect(read.artifact.records).toHaveLength(1);
      expect(read.artifact.records[0]?.abandonment?.reservedAttempts).toBe(2);
      expect(read.artifact.index.spent.attempts).toBe(2);
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(observed).toBe(2);
    });
  });

  it('does not charge a proven offline pre-send backend refusal as an unknown request', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      await writeFile(
        area.fixturePath,
        JSON.stringify({
          fixtureVersion: 'eval-offline-fixture-v1',
          description: 'no scripted socket available',
          cells: {},
          notes: [],
        }),
      );
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('run missing');
      expect(read.artifact.records).toHaveLength(2);
      expect(
        read.artifact.records.every(
          (record) =>
            record.attempts.length === 0 &&
            record.abandonment === null &&
            record.status === 'failed',
        ),
      ).toBe(true);
      expect(read.artifact.index.spent.attempts).toBe(0);
    });
  });

  it('uses the chosen candidate renderer in both preparation and the actual reviewer', async () => {
    await withWorkflowArea(async (area) => {
      const candidate = {
        candidateId: 'compact-check',
        prompt: 'no-probe' as const,
        structure: 'compact' as const,
        history: 'current-turn' as const,
        scale: 'complete' as const,
      };
      const plan = { ...area.plan, candidate };
      await area.write(plan);
      const loaded = await sources.loadWorkflowSources(area.root, plan);
      const source = loaded.cases[0];
      if (source === undefined) throw new Error('source missing');
      const baseline = await sources.sourceMaterial(
        source,
        'decision',
        area.plan,
      );
      const selected = await sources.sourceMaterial(source, 'decision', plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('run missing');
      expect(read.artifact.records[0]?.material?.promptFingerprint).toBe(
        selected.material.promptFingerprint,
      );
      expect(read.artifact.records[0]?.material?.promptFingerprint).not.toBe(
        baseline.material.promptFingerprint,
      );
      expect(read.artifact.records[0]?.outcome).toMatchObject({
        status: 'scored',
        risk: 2,
        authorization: 10,
      });
    });
  });
});
