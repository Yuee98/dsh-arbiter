import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRun, RUN_FILES } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import {
  effectiveWorkflowConfig,
  loadWorkflowSources,
  resolveWorkflowPlan,
} from '../../evals/src/run/source.js';
import { createRun, resumeRun } from '../../evals/src/run/lifecycle.js';
import { versionsFor } from '../../evals/src/run/commands.js';
import { candidateOf } from '../../evals/src/run/candidate.js';
import { dispatch } from '../../evals/src/run/scheduler.js';
import {
  withResourceClaim,
  certifyResourceAccounting,
} from '../../evals/src/run/resource.js';
import { cellGrid } from '../../evals/src/run/plan.js';
import { withWorkflowArea } from './helpers/workflow-run.js';

const checkers = await compileRunCheckers();

describe('workflow inputs are explicit, frozen and source-aware', () => {
  it('does not accept a held claim without fresh persisted accounting', async () => {
    await withWorkflowArea(async (area) => {
      const authored = {
        ...area.plan,
        resource: {
          runDirectory: area.runDirectory,
          maxAttempts: 2,
          maxEstimatedInputTokens: 20000,
        },
      };
      await area.write(authored);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const data = await loadWorkflowSources(area.root, authored);
      const plan = resolveWorkflowPlan(authored, data.cases);
      const fixture = checkers.fixture(
        JSON.parse(await readFile(area.fixturePath, 'utf8')),
      );
      if (!fixture.ok) throw new Error('fixture missing');
      await expect(
        withResourceClaim(plan, area.runDirectory, async (resourceLease) =>
          dispatch({
            runId: 'stale-allowance',
            plan,
            cells: cellGrid(plan).cells,
            cases: new Map(data.cases.map((source) => [source.caseId, source])),
            fixture: fixture.document.cells,
            versions: versionsFor(plan),
            llm: null,
            readCredential: () => undefined,
            signal: new AbortController().signal,
            alreadySpentAttempts: 0,
            resourceLease,
          }),
        ),
      ).rejects.toThrow('fresh persisted accounting');
    });
  });
  it('charges persisted attempts despite a supplied zero and consumes the observation once', async () => {
    await withWorkflowArea(async (area) => {
      const authored = {
        ...area.plan,
        resource: {
          runDirectory: area.runDirectory,
          maxAttempts: 2,
          maxEstimatedInputTokens: 20000,
        },
      };
      await area.write(authored);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const loaded = await loadWorkflowSources(area.root, authored);
      const plan = resolveWorkflowPlan(authored, loaded.cases);
      const fixture = checkers.fixture(
        JSON.parse(await readFile(area.fixturePath, 'utf8')),
      );
      if (!fixture.ok) throw new Error('fixture missing');
      await withResourceClaim(plan, area.runDirectory, async (lease) => {
        await certifyResourceAccounting(plan, lease, checkers);
        const options = {
          runId: 'persisted-allowance',
          plan,
          cells: cellGrid(plan).cells,
          cases: new Map(loaded.cases.map((source) => [source.caseId, source])),
          fixture: fixture.document.cells,
          versions: versionsFor(plan),
          llm: null,
          readCredential: () => {
            throw new Error('exhausted allowance reached a backend');
          },
          signal: new AbortController().signal,
          alreadySpentAttempts: 0,
          resourceLease: lease,
        };
        const result = await dispatch(options);
        expect(result.stoppedBy).toBe('budget-exhausted');
        expect(
          result.results.every(
            (cell) => cell.attempts === 0 && cell.record === null,
          ),
        ).toBe(true);
        expect(
          result.results.some((cell) => cell.status === 'budget-exhausted'),
        ).toBe(true);
        expect(result.results).toHaveLength(2);
        await expect(dispatch(options)).rejects.toThrow(
          'fresh persisted accounting',
        );
      });
    });
  });

  it.each([
    'missing cell',
    'duplicate cell',
    'unknown target',
    'wrong record path',
    'unindexed record',
  ])('refuses fresh accounting with %s before dispatch', async (corruption) => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('artifact missing');
      const first = read.artifact.index.cells[0];
      if (first === undefined) throw new Error('cell missing');
      if (corruption === 'unindexed record') {
        await writeFile(
          join(area.runDirectory, RUN_FILES.records, 'unknown.json'),
          '{}',
        );
      } else {
        const cells =
          corruption === 'missing cell'
            ? [first]
            : corruption === 'duplicate cell'
              ? [first, first]
              : [
                  {
                    ...first,
                    ...(corruption === 'unknown target'
                      ? { targetId: 'unknown' }
                      : { record: 'records/other.json' }),
                  },
                  ...read.artifact.index.cells.slice(1),
                ];
        await writeFile(
          join(area.runDirectory, RUN_FILES.index),
          JSON.stringify({ ...read.artifact.index, cells }),
        );
      }
      await expect(
        withResourceClaim(
          read.artifact.plan,
          area.runDirectory,
          async (lease) => {
            await certifyResourceAccounting(
              read.artifact.plan,
              lease,
              checkers,
            );
          },
        ),
      ).rejects.toThrow('consumption is unknown');
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
    });
  });

  it('uses provided offline project rules and rejects missing or empty rule declarations', async () => {
    await withWorkflowArea(async (area) => {
      const workflow = area.plan.workflow;
      if (workflow === undefined) throw new Error('workflow fixture missing');
      const input = {
        customRules: 'GLOBAL_POLICY_SENTINEL',
        projectRules: {
          kind: 'provided' as const,
          text: 'PROJECT_POLICY_SENTINEL: preserve assets.',
        },
      };
      await area.write({ ...area.plan, workflow: { ...workflow, input } });
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('artifact missing');
      const text = JSON.stringify(
        read.artifact.records[0]?.attempts[0]?.request,
      );
      expect(text).toContain('PROJECT_POLICY_SENTINEL');
      expect(text).toContain('GLOBAL_POLICY_SENTINEL');
      expect(read.artifact.index.workflowExecution?.config).toMatchObject({
        context: { projectRules: { enabled: true } },
      });
      await writeFile(
        area.planPath,
        JSON.stringify({
          ...area.plan,
          workflow: { ...workflow, input: { customRules: '' } },
        }),
      );
      expect(await area.cli(['plan', area.planPath])).toBe(1);
      await area.write({
        ...area.plan,
        workflow: {
          ...workflow,
          input: { ...input, projectRules: { kind: 'provided', text: '  ' } },
        },
      });
      expect(await area.cli(['plan', area.planPath])).toBe(1);
    });
  });

  it('rejects effective config drift even when the frozen plan bytes did not change', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const path = join(area.runDirectory, RUN_FILES.index);
      const decoded = checkers.index(JSON.parse(await readFile(path, 'utf8')));
      if (!decoded.ok || decoded.document.workflowExecution === undefined)
        throw new Error('index invalid');
      await writeFile(
        path,
        JSON.stringify({
          ...decoded.document,
          workflowExecution: {
            ...decoded.document.workflowExecution,
            config: { ...effectiveWorkflowConfig(area.plan), boundary: 'off' },
          },
        }),
      );
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(area.log.join('\n')).toContain('effective configuration moved');
    });
  });

  it('reads fresh persisted consumption instead of a stale caller snapshot', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      const loaded = await loadWorkflowSources(area.root, area.plan);
      const plan = resolveWorkflowPlan(area.plan, loaded.cases);
      const fixture = checkers.fixture(
        JSON.parse(await readFile(area.fixturePath, 'utf8')),
      );
      if (!fixture.ok) throw new Error('fixture invalid');
      const created = await createRun({
        directory: area.runDirectory,
        runId: 'fresh-accounting',
        plan,
        cases: loaded.cases,
        datasetDigest: loaded.digest,
        fixture: fixture.document,
        versions: versionsFor(plan),
        now: Date.now,
      });
      if (!created.ok) throw new Error(created.problems.join('; '));
      const options = {
        directory: area.runDirectory,
        existing: { index: created.index, records: [] },
        cases: loaded.cases,
        fixture: fixture.document,
        versions: versionsFor(plan),
        checkers,
        llm: null,
        readCredential: () => undefined,
        signal: new AbortController().signal,
        continuation: false,
      };
      expect((await resumeRun(options)).index.spent.attempts).toBe(2);
      const second = await resumeRun(options);
      expect(second.index.spent.attempts).toBe(2);
      expect(second.ran).toBe(0);
      expect(
        await readFile(join(area.runDirectory, RUN_FILES.lock), 'utf8').catch(
          () => null,
        ),
      ).toBeNull();
    });
  });

  it('does not allow direct scheduler dispatch to bypass the workflow scope', async () => {
    await withWorkflowArea(async (area) => {
      const loaded = await loadWorkflowSources(area.root, area.plan);
      const plan = resolveWorkflowPlan(area.plan, loaded.cases);
      // The package is real; the refusal occurs before material or a backend can be used.
      expect(candidateOf(plan).isBaseline).toBe(true);
      await expect(
        dispatch({
          runId: 'bypass',
          plan,
          cells: cellGrid(plan).cells,
          cases: new Map(loaded.cases.map((source) => [source.caseId, source])),
          fixture: {},
          versions: versionsFor(plan),
          llm: null,
          readCredential: () => {
            throw new Error('credential reached');
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('held resource claim');
    });
  });

  it('keeps unsupported views addressable with their real lineage and refuses corrupt records', async () => {
    await withWorkflowArea(async (area) => {
      await area.write({ ...area.plan, protocols: ['chat', 'decision'] });
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      if (!read.ok) throw new Error('artifact missing');
      expect(
        read.artifact.index.cells.filter(
          (cell) => cell.status === 'unsupported',
        ),
      ).toHaveLength(2);
      expect(
        read.artifact.plan.workflow?.points.every(
          (point) => point.lineageId === 'independent-lineage',
        ),
      ).toBe(true);
      const record = read.artifact.records[0];
      if (record === undefined) throw new Error('record missing');
      await writeFile(
        join(area.runDirectory, RUN_FILES.records, `${record.cellId}.json`),
        '{broken',
      );
      expect(await area.cli(['run', area.planPath, '--resume'])).toBe(1);
      expect(area.log.join('\n')).toContain('consumption is unknown');
    });
  });
});
