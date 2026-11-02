import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportRun } from '../../evals/src/report/command.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  dualProtocolPlan,
  workflowReport,
} from '../evals/helpers/report-workflow.js';
import { chatTarget } from '../evals/helpers/run.js';

const formats = ['json', 'md', 'html'] as const;
async function publish(root: string, directory: string, output: string) {
  const exit = await reportRun(
    { root, out: () => {}, err: () => {} },
    {
      directory,
      dataset: null,
      references: [],
      output,
      mode: 'ask',
      channel: 'available',
      force: false,
    },
  );
  const texts = await Promise.all(
    formats.map((extension) => readFile(`${output}.${extension}`, 'utf8')),
  );
  return { exit, texts };
}
describe(
  'validity and confidentiality of published workflow reports',
  { timeout: 30_000 },
  () => {
    it.each(['unsupported', 'budget'] as const)(
      'reports a legitimate zero-dispatch %s population successfully',
      async (kind) => {
        await withWorkflowArea(async (area) => {
          const plan =
            kind === 'unsupported'
              ? { ...area.plan, targets: [chatTarget()] }
              : {
                  ...area.plan,
                  bounds: { ...area.plan.bounds, maxInputTokens: 5 },
                };
          await area.write(plan);
          expect(await area.cli(['run', area.planPath])).toBe(
            kind === 'unsupported' ? 0 : 1,
          );
          const actual = await readRun(
            area.runDirectory,
            await compileRunCheckers(),
            { allowWorkflow: true },
          );
          if (!actual.ok) throw new Error('missing actual run');
          expect(actual.artifact.records).toHaveLength(0);
          const published = await publish(
            area.root,
            area.runDirectory,
            join(area.directory, 'report'),
          );
          expect(published.exit).toBe(0);
          expect(published.texts[0]).toContain('"records-read"');
          const report = await workflowReport(area.root, area.runDirectory, []);
          expect(
            report.checks.find((check) => check.name === 'records-read')?.ok,
          ).toBe(true);
          expect(report.coverage).toMatchObject({
            cellsPlanned: 2,
            records: 0,
            missing: [],
          });
          expect(report.quality?.overall.conditions).toMatchObject({
            cells: 2,
            compared: 0,
          });
          expect(report.quality?.identities).toMatchObject({
            roots: 1,
            points: 2,
            views: 2,
          });
        });
      },
    );
    it('still rejects truly dispatched records that are absent', async () => {
      await withWorkflowArea(async (area) => {
        await area.write();
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const actual = await readRun(
          area.runDirectory,
          await compileRunCheckers(),
          { allowWorkflow: true },
        );
        if (!actual.ok) throw new Error('missing actual run');
        for (const cell of actual.artifact.index.cells)
          await rm(join(area.runDirectory, cell.record));
        const result = await publish(
          area.root,
          area.runDirectory,
          join(area.directory, 'missing-report'),
        );
        expect(result.exit).toBe(1);
        const report = await workflowReport(area.root, area.runDirectory, []);
        expect(
          report.checks.find((check) => check.name === 'records-read')?.ok,
        ).toBe(false);
        expect(
          report.checks.find(
            (check) => check.name === 'dispatched-cells-have-records',
          )?.ok,
        ).toBe(false);
        expect(report.coverage.missing).toHaveLength(2);
      });
    });
    it('omits credential and unrecognizable private configuration text from all formats without rewriting evidence', async () => {
      await withWorkflowArea(async (area) => {
        const base = dualProtocolPlan(area.plan);
        if (base.workflow === undefined) throw new Error('workflow required');
        const secret = 'synthetic-canary-secret';
        const privateText = 'INTERNAL_REPORT_NOTE_ONLY';
        const plan = {
          ...base,
          repeats: 1,
          workflow: {
            ...base.workflow,
            input: {
              ...base.workflow.input,
              customRules: `Authorization: Bearer ${secret}\n${privateText}`,
            },
          },
        };
        await area.write(plan);
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const indexPath = join(area.runDirectory, 'index.json');
        const before = await readFile(indexPath, 'utf8');
        expect(before).toContain(secret);
        expect(before).toContain(privateText);
        const published = await publish(
          area.root,
          area.runDirectory,
          join(area.directory, 'public-report'),
        );
        expect(published.exit).toBe(0);
        expect(
          Object.fromEntries(
            formats.map((format, index) => [
              format,
              published.texts[index]?.includes(secret),
            ]),
          ),
        ).toEqual({ json: false, md: false, html: false });
        expect(
          published.texts.every((text) => !text.includes(privateText)),
        ).toBe(true);
        const actual = await readRun(
          area.runDirectory,
          await compileRunCheckers(),
          { allowWorkflow: true },
        );
        if (!actual.ok) throw new Error('missing actual run');
        const report = await workflowReport(area.root, area.runDirectory, []);
        expect(report.run.workflowExecution).toMatchObject({
          configRevision:
            actual.artifact.index.workflowExecution?.configRevision,
          configEvidence: 'index.json#/workflowExecution/config',
          config: {
            context: {
              maxInputTokens: 10000,
              targetInputTokens: 6000,
              projectRules: { enabled: true },
            },
          },
        });
        expect(await readFile(indexPath, 'utf8')).toBe(before);
        const execution = actual.artifact.index.workflowExecution;
        if (
          execution === undefined ||
          execution.config === null ||
          typeof execution.config !== 'object'
        )
          throw new Error('missing config');
        await writeFile(
          indexPath,
          JSON.stringify({
            ...actual.artifact.index,
            workflowExecution: {
              ...execution,
              config: {
                ...execution.config,
                unrecognizedPrivateField: 'UNVERIFIED_PRIVATE_CONFIG',
              },
            },
          }),
        );
        const changed = await publish(
          area.root,
          area.runDirectory,
          join(area.directory, 'unverified-report'),
        );
        expect(
          changed.texts.every(
            (text) =>
              !text.includes('UNVERIFIED_PRIVATE_CONFIG') &&
              !text.includes(secret),
          ),
        ).toBe(true);
      });
    });
  },
);
