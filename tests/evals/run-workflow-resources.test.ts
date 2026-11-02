import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as service from '../../src/reviewer/service.js';
import { readRun, RUN_FILES } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { withWorkflowArea } from './helpers/workflow-run.js';

const checkers = await compileRunCheckers();
afterEach(() => vi.restoreAllMocks());

describe('one workflow resource scope cannot regain allowance', () => {
  it.each(['attempts', 'input'] as const)(
    'enforces the cumulative %s ceiling with two workers and on resume',
    async (bound) => {
      await withWorkflowArea(async (area) => {
        const plan = {
          ...area.plan,
          resource: {
            runDirectory: area.runDirectory,
            maxAttempts: bound === 'attempts' ? 1 : 8,
            maxEstimatedInputTokens: bound === 'input' ? 10000 : 80000,
          },
        };
        await area.write(plan);
        expect(await area.cli(['run', area.planPath])).toBe(1);
        const first = await readRun(area.runDirectory, checkers, {
          allowWorkflow: true,
        });
        if (!first.ok) throw new Error('resource run missing');
        const record = first.artifact.records[0];
        if (record === undefined) throw new Error('first record missing');
        expect(first.artifact.index.spent.attempts).toBe(1);
        expect(first.artifact.records).toHaveLength(1);
        expect(first.artifact.records[0]?.workflow?.pointId).toBe(
          'format-clean',
        );
        const bytes = await readFile(
          join(area.runDirectory, RUN_FILES.records, `${record.cellId}.json`),
          'utf8',
        );
        expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
        const second = await readRun(area.runDirectory, checkers, {
          allowWorkflow: true,
        });
        if (!second.ok) throw new Error('resumed run missing');
        expect(second.artifact.index.spent.attempts).toBe(1);
        expect(second.artifact.records).toHaveLength(1);
        expect(
          await readFile(
            join(area.runDirectory, RUN_FILES.records, `${record.cellId}.json`),
            'utf8',
          ),
        ).toBe(bytes);
      });
    },
  );

  it('refuses an initial request above H with zero sent attempts', async () => {
    await withWorkflowArea(async (area) => {
      await area.write({
        ...area.plan,
        bounds: { ...area.plan.bounds, maxInputTokens: 5 },
      });
      expect(await area.cli(['run', area.planPath])).toBe(1);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('bounded run missing');
      expect(read.artifact.records).toHaveLength(0);
      expect(read.artifact.index.spent.attempts).toBe(0);
      expect(read.artifact.index.status).toBe('budget-exhausted');
    });
  });

  it('does not reissue a decided request when its record is missing', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const names = await readdir(join(area.runDirectory, RUN_FILES.records));
      const removed = names[0];
      if (removed === undefined) throw new Error('fixture wrote no records');
      await rm(join(area.runDirectory, RUN_FILES.records, removed));
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(
        await readdir(join(area.runDirectory, RUN_FILES.records)),
      ).not.toContain(removed);
      expect(area.log.join('\n')).toContain('consumption is unknown');
    });
  });

  it('refuses a new run over orphan records even if both headers were lost', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      await rm(join(area.runDirectory, RUN_FILES.plan));
      await rm(join(area.runDirectory, RUN_FILES.index));
      expect(await area.cli(['run', area.planPath])).toBe(1);
      expect(area.log.join('\n')).toContain('orphan records');
      expect(
        await readdir(join(area.runDirectory, RUN_FILES.records)),
      ).toHaveLength(2);
    });
  });

  it('charges an unreported post-transport failure and stops before the next request', async () => {
    await withWorkflowArea(async (area) => {
      const actual = service.reviewWith;
      let observedAttempts = 0;
      vi.spyOn(service, 'reviewWith').mockImplementation(
        (pkg) => async (options) => {
          const result = await actual(pkg)(options);
          observedAttempts += result.attempts.length;
          throw new Error('service lost the attempt result after transport');
        },
      );
      await area.write({
        ...area.plan,
        bounds: { ...area.plan.bounds, concurrency: 1 },
      });
      expect(await area.cli(['run', area.planPath])).toBe(1);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('failed run missing');
      expect(observedAttempts).toBe(1);
      expect(read.artifact.records).toHaveLength(1);
      expect(read.artifact.records[0]?.attempts).toEqual([]);
      expect(read.artifact.records[0]?.abandonment?.reservedAttempts).toBe(1);
      expect(read.artifact.index.spent.attempts).toBe(1);
      expect(read.artifact.index.status).toBe('in-flight-timeout');
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(observedAttempts).toBe(1);
      expect(area.log.join('\n')).toContain('outstanding');
    });
  });

  it('leaves the existing claim held if a sent request cannot be recorded', async () => {
    await withWorkflowArea(async (area) => {
      const actual = service.reviewWith;
      let sent = 0;
      vi.spyOn(service, 'reviewWith').mockImplementation(
        (pkg) => async (options) => {
          const result = await actual(pkg)(options);
          sent += result.attempts.length;
          await rm(join(area.runDirectory, RUN_FILES.records), {
            recursive: true,
          });
          await writeFile(
            join(area.runDirectory, RUN_FILES.records),
            'unwritable record destination',
          );
          return result;
        },
      );
      await area.write({
        ...area.plan,
        bounds: { ...area.plan.bounds, concurrency: 1 },
      });
      expect(await area.cli(['run', area.planPath])).toBe(1);
      expect(sent).toBe(1);
      expect(
        await readFile(join(area.runDirectory, RUN_FILES.lock), 'utf8'),
      ).toContain('pid');
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(sent).toBe(1);
    });
  });
});
