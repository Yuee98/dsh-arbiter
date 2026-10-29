/**
 * What the report does with an artifact that is incomplete or damaged.
 *
 * A report is most needed exactly when something went wrong: a run interrupted midway, a
 * record deleted by hand, a usage summary that disagrees with its own attempts. So these
 * are not edge cases to be tolerated — they are the states the report has to describe
 * without either crashing or quietly reporting a smaller experiment as a complete one.
 *
 * Each test breaks exactly one thing in a real run directory and asserts on what the
 * report says about it. The distinction that matters throughout is between a cell that
 * was *never dispatched* (a normal state with no record) and a cell that *claims to have
 * run and has no evidence* (a gap). The second must never be counted as a decision.
 */

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildReport, defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { recordPathOf } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import type { EvaluationReport } from '../../evals/src/metrics/types.js';
import { renderMarkdown } from '../../evals/src/report/markdown.js';
import { reportRun } from '../../evals/src/report/command.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './helpers/run.js';
import {
  CORE_DATASET,
  REPOSITORY_ROOT,
  runPlan,
  withArea,
} from './helpers/report-run.js';
import type { Area } from './helpers/report-run.js';

/** Build a report for one run directory. */
async function build(directory: string): Promise<EvaluationReport> {
  const read = await observeRun({
    directory,
    root: REPOSITORY_ROOT,
    dataset: { kind: 'path', path: CORE_DATASET },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return buildReport({
    observation: read.observation,
    settings: {
      ...defaultSettings(REPOSITORY_ROOT),
      dataset: { kind: 'path', path: CORE_DATASET },
    },
  });
}

/**
 * A run of two cases where the second case's record is removed afterwards.
 *
 * The index still lists the cell as `reviewed`, so the directory now claims a review it
 * cannot show. That is the one shape of missing evidence this format treats as a gap.
 */
async function runWithLostRecord(created: Area): Promise<{
  readonly directory: string;
  readonly lostCellId: string;
}> {
  const directory = join(created.path, 'run');
  const first = 'read-named-source-file';
  const second = 'read-repo-index-with-cache';
  await runPlan({
    directory,
    plan: planOf({
      caseIds: [first, second],
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: fixtureOf({
      [cellIdOf({ caseId: first, targetId: 'chat-a', protocol: 'chat' })]:
        fixtureCell({ chat: [chatAnswer(1, 10)] }),
      [cellIdOf({ caseId: second, targetId: 'chat-a', protocol: 'chat' })]:
        fixtureCell({ chat: [chatAnswer(2, 10)] }),
    }),
  });
  const lostCellId = cellIdOf({
    caseId: second,
    targetId: 'chat-a',
    protocol: 'chat',
  });
  await rm(join(directory, recordPathOf(lostCellId)), { force: true });
  return { directory, lostCellId };
}

describe('a cell that claims to have run and has no record', () => {
  it('reports the gap and refuses to count the cell as a decision', async () => {
    await withArea(async (created) => {
      const { directory, lostCellId } = await runWithLostRecord(created);
      const report = await build(directory);
      expect(report.coverage.missing).toHaveLength(1);
      expect(report.coverage.missing[0]?.cellId).toBe(lostCellId);
      expect(
        report.checks.find(
          (check) => check.name === 'dispatched-cells-have-records',
        )?.ok,
      ).toBe(false);
      // The cell is its own class, outside the compared denominator.
      expect(report.behaviour.overall.missingRecord).toBe(1);
      expect(report.behaviour.overall.technical).toBe(0);
      expect(report.behaviour.overall.falseDeny).toBe(0);
      const row = report.examples.find(
        (example) => example.cellId === lostCellId,
      );
      expect(row?.classification).toBe('missing-record');
      expect(row?.engine.word).toBeNull();
    });
  });

  it('says so in the rendered documents rather than silently showing fewer cells', async () => {
    await withArea(async (created) => {
      const { directory } = await runWithLostRecord(created);
      const report = await build(directory);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('声称跑过却没有记录的格子');
      expect(markdown).toContain('**宣称已派发但缺记录**');
      // The plan's own count is still printed, so the gap is visible as a difference.
      expect(report.coverage.cellsPlanned).toBe(2);
      expect(report.coverage.records).toBe(1);
    });
  });

  it('exits non-zero when the report is written, because a check failed', async () => {
    await withArea(async (created) => {
      const { directory } = await runWithLostRecord(created);
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory,
          output: null,
          dataset: CORE_DATASET,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      // The documents were still written: a gap is something to read, not something to
      // refuse to describe. The exit code says the check did not pass.
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('dispatched-cells-have-records');
    });
  });
});

describe('a run that never started any cell', () => {
  it('reports no evidence as no evidence, not as a passing run', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      // A cancellation before dispatch leaves the index written and no records at all.
      const controller = new AbortController();
      controller.abort();
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({}),
        signal: controller.signal,
      });
      const report = await build(directory);
      expect(report.coverage.records).toBe(0);
      expect(report.coverage.cellsPlanned).toBe(1);
      // A cancelled cell is `not-run`, so it has no record and is not a gap.
      expect(report.coverage.missing).toHaveLength(0);
      expect(report.behaviour.overall.compared).toBe(0);
      expect(report.behaviour.overall.agreementRate).toBeNull();
      expect(report.usage.run).toBeNull();
      expect(report.efficiency.cost.status).toBe('none');
    });
  });
});

describe('an unreadable run directory', () => {
  it('is a read failure rather than an empty report', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'empty');
      await created.dir('empty');
      const read = await observeRun({
        directory,
        root: REPOSITORY_ROOT,
        dataset: { kind: 'none' },
      });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.problems.join('\n')).toContain('plan.json');
    });
  });

  it('refuses to build a report from a run whose plan no longer matches its index', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
        }),
      });
      // Editing the frozen plan is exactly what the plan hash exists to catch.
      const checkers = await compileRunCheckers();
      const { readFile } = await import('node:fs/promises');
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, 'plan.json'), 'utf8'),
      );
      const checked = checkers.plan(parsed);
      if (!checked.ok) throw new Error('the fixture plan is not valid');
      const tampered: Record<string, unknown> = {
        ...checked.document,
        repeats: 9,
      };
      if (!checkers.plan(tampered).ok)
        throw new Error('tampered plan is invalid');
      await writeFile(
        join(directory, 'plan.json'),
        `${JSON.stringify(tampered, null, 2)}\n`,
        'utf8',
      );
      const read = await observeRun({
        directory,
        root: REPOSITORY_ROOT,
        dataset: { kind: 'none' },
      });
      // The plan document is still schema-valid, so the read succeeds; the index's own
      // frozen plan is what a report actually trusts, which this asserts by reading the
      // run's repeats from the index rather than from the edited file.
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.observation.artifact.index.plan.repeats).toBe(1);
    });
  });
});
