import { readFile, writeFile, cp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as service from '../../src/reviewer/service.js';
import { readRun, RUN_FILES } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { createRun, resumeRun } from '../../evals/src/run/lifecycle.js';
import { versionsFor } from '../../evals/src/run/commands.js';
import {
  loadWorkflowSources,
  resolveWorkflowPlan,
} from '../../evals/src/run/source.js';
import { withWorkflowArea } from './helpers/workflow-run.js';

const checkers = await compileRunCheckers();
afterEach(() => vi.restoreAllMocks());

describe('workflow continuation preserves population and evidence', () => {
  it('continues only the missing cell after an interrupted first pass, with original records unchanged', async () => {
    await withWorkflowArea(async (area) => {
      const authored = {
        ...area.plan,
        bounds: { ...area.plan.bounds, concurrency: 1 },
      };
      await area.write(authored);
      const data = await loadWorkflowSources(area.root, authored);
      const plan = resolveWorkflowPlan(authored, data.cases);
      const fixture = checkers.fixture(
        JSON.parse(await readFile(area.fixturePath, 'utf8')),
      );
      if (!fixture.ok) throw new Error('invalid fixture');
      const created = await createRun({
        directory: area.runDirectory,
        runId: 'interrupt-test',
        plan,
        cases: data.cases,
        datasetDigest: data.digest,
        fixture: fixture.document,
        versions: versionsFor(plan),
        now: Date.now,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const controller = new AbortController();
      const options = {
        directory: area.runDirectory,
        existing: { index: created.index, records: [] },
        cases: data.cases,
        fixture: fixture.document,
        versions: versionsFor(plan),
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: controller.signal,
        continuation: false,
        onProgress: () => {
          controller.abort();
        },
      };
      const first = await resumeRun(options);
      expect(first.index.spent.attempts).toBe(1);
      expect(first.index.resumed).toEqual([]);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok || read.artifact.records[0] === undefined)
        throw new Error('first record missing');
      const path = join(
        area.runDirectory,
        RUN_FILES.records,
        `${read.artifact.records[0].cellId}.json`,
      );
      const bytes = await readFile(path, 'utf8');
      const second = await resumeRun({
        ...options,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        continuation: true,
      });
      expect(second.ran).toBe(1);
      expect(second.index.spent.attempts).toBe(2);
      expect(second.index.resumed).toHaveLength(1);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    });
  });

  it('refuses a copied directory while canonical aliases share the original scope', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const copied = join(area.directory, 'copied-run');
      await cp(area.runDirectory, copied, { recursive: true });
      expect(
        await area.cli(['run', area.planPath, '--dir', copied, '--resume']),
      ).toBe(1);
      expect(area.log.join('\n')).toContain(
        'forbids a different run directory',
      );
      const alias = join(area.directory, 'alias');
      await symlink(
        area.runDirectory,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(
        await area.cli(['run', area.planPath, '--dir', alias, '--resume']),
      ).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('scope missing');
      expect(read.artifact.index.spent.attempts).toBe(2);
    });
  });

  it('refuses a changed fixture and preserves source identity on timeout', async () => {
    await withWorkflowArea(async (area) => {
      const actual = service.reviewWith;
      let sent = 0;
      vi.spyOn(service, 'reviewWith').mockImplementation(
        (pkg) => async (options) => {
          const result = await actual(pkg)(options);
          sent += result.attempts.length;
          return new Promise(() => undefined);
        },
      );
      await area.write({
        ...area.plan,
        bounds: { ...area.plan.bounds, concurrency: 1, timeoutMs: 30 },
      });
      expect(await area.cli(['run', area.planPath])).toBe(1);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('timed out scope missing');
      expect(sent).toBe(1);
      expect(read.artifact.records[0]).toMatchObject({
        status: 'timeout',
        workflow: {
          rootId: 'format-build',
          lineageId: 'independent-lineage',
          viewId: 'format-clean-main',
        },
        abandonment: { reservedAttempts: 1 },
      });
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      const decoded = checkers.fixture(
        JSON.parse(await readFile(area.fixturePath, 'utf8')),
      );
      if (!decoded.ok) throw new Error('fixture invalid');
      await writeFile(
        area.fixturePath,
        JSON.stringify({
          ...decoded.document,
          description: 'a changed socket',
        }),
      );
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(area.log.join('\n')).toContain('offline fixture changed');
      expect(sent).toBe(1);
    });
  });
});
