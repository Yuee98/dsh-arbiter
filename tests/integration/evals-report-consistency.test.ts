import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import { loadWorkflowSources } from '../../evals/src/run/source.js';
import { createRun, resumeRun } from '../../evals/src/run/lifecycle.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { versionsFor } from '../../evals/src/run/commands.js';
import { reportRun } from '../../evals/src/report/command.js';

describe('published index consistency', { timeout: 30_000 }, () => {
  it('exposes completed records beside a stale not-run index without rewriting either', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      const loaded = await loadWorkflowSources(area.root, area.plan);
      const checkers = await compileRunCheckers();
      const value: unknown = JSON.parse(
        await readFile(area.fixturePath, 'utf8'),
      );
      const fixture = checkers.fixture(value);
      if (!fixture.ok) throw new Error('invalid fixture');
      const versions = versionsFor(area.plan);
      const created = await createRun({
        directory: area.runDirectory,
        runId: 'stale-index',
        plan: area.plan,
        cases: loaded.cases,
        datasetDigest: loaded.digest,
        fixture: fixture.document,
        versions,
        now: Date.now,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      await expect(
        resumeRun({
          directory: area.runDirectory,
          existing: { index: created.index, records: [] },
          cases: loaded.cases,
          fixture: fixture.document,
          versions,
          checkers,
          llm: null,
          readCredential: () => {
            throw new Error('offline');
          },
          signal: new AbortController().signal,
          continuation: false,
          onProgress: () => {
            throw new Error('after persisted record');
          },
        }),
      ).rejects.toThrow('after persisted record');
      const indexPath = join(area.runDirectory, 'index.json');
      const before = await readFile(indexPath, 'utf8');
      const output = join(area.directory, 'report');
      expect(
        await reportRun(
          { root: area.root, out: () => {}, err: () => {} },
          {
            directory: area.runDirectory,
            dataset: null,
            output,
            mode: 'ask',
            channel: 'available',
            force: false,
          },
        ),
      ).toBe(1);
      const json: unknown = JSON.parse(
        await readFile(`${output}.json`, 'utf8'),
      );
      const expectedCells: unknown = expect.arrayContaining([
        expect.objectContaining({
          indexStatus: 'not-run',
          recordStatus: 'reviewed',
          mismatch: true,
        }),
      ]);
      const expectedChecks: unknown = expect.arrayContaining([
        expect.objectContaining({
          name: 'index-record-consistency',
          ok: false,
        }),
      ]);
      expect(json).toMatchObject({
        run: { status: 'running' },
        coverage: { statuses: { 'not-run': 2 } },
        publication: {
          consistency: {
            indexReliable: false,
            cells: expectedCells,
          },
        },
        checks: expectedChecks,
      });
      expect(await readFile(`${output}.md`, 'utf8')).toContain(
        '索引与持久化记录不一致',
      );
      expect(await readFile(indexPath, 'utf8')).toBe(before);
      // A normal rebuild of identical saved evidence and publication inputs is deterministic.
      const first = await readFile(`${output}.json`, 'utf8');
      expect(
        await reportRun(
          { root: area.root, out: () => {}, err: () => {} },
          {
            directory: area.runDirectory,
            dataset: null,
            output,
            mode: 'ask',
            channel: 'available',
            force: true,
          },
        ),
      ).toBe(1);
      expect(await readFile(`${output}.json`, 'utf8')).toBe(first);
    });
  });
});
