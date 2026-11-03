import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportRun } from '../../evals/src/report/command.js';
import { readRun, recordPathOf } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { cellGrid } from '../../evals/src/run/grid.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  coreCases,
  runPlan,
  unlabelledCoreDataset,
  withArea,
  REPOSITORY_ROOT,
} from '../evals/helpers/report-run.js';
import {
  chatAnswer,
  cellIdOf,
  fixtureCell,
  fixtureOf,
  planOf,
} from '../evals/helpers/run.js';
import { reportBrowserFixture } from '../evals/helpers/report-browser.js';
import { readJson, objectsAt, textAt } from '../evals/helpers/replay.js';

async function publish(
  root: string,
  directory: string,
  prefix: string,
  expectedExit = 0,
) {
  const messages: string[] = [];
  const exit = await reportRun(
    {
      root,
      out: (text) => messages.push(text),
      err: (text) => messages.push(text),
    },
    {
      directory,
      dataset: null,
      references: [],
      output: prefix,
      mode: 'ask',
      channel: 'available',
      force: false,
    },
  );
  expect(exit).toBe(expectedExit);
  const [json, markdown, html] = await Promise.all(
    ['json', 'md', 'html'].map((format) =>
      readFile(`${prefix}.${format}`, 'utf8'),
    ),
  );
  if (json === undefined || markdown === undefined || html === undefined)
    throw new Error('missing report format');
  return { json, markdown, html, parsed: await readJson(`${prefix}.json`) };
}

describe('public stored report evidence', { timeout: 30_000 }, () => {
  it('distinguishes empty/null responses, a refused repair, no attempts and index/record disagreement', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(
        area.runDirectory,
        await compileRunCheckers(),
        { allowWorkflow: true },
      );
      if (!read.ok) throw new Error(JSON.stringify(read.problems));
      const [first, second] = read.artifact.records;
      const initial = first?.attempts[0];
      if (first === undefined || second === undefined || initial === undefined)
        throw new Error('missing stored attempts');
      await writeFile(
        join(area.runDirectory, recordPathOf(first.cellId)),
        JSON.stringify({
          ...first,
          usage: null,
          attempts: [
            { ...initial, responseText: '', error: null },
            {
              ...initial,
              attempt: 2,
              kind: 'repair',
              attemptId: `${initial.attemptId}-guard`,
              sent: false,
              request: null,
              responseText: null,
              error: 'Synthetic pre-send guard refusal',
            },
          ],
        }),
      );
      await writeFile(
        join(area.runDirectory, recordPathOf(second.cellId)),
        JSON.stringify({ ...second, usage: null, attempts: [] }),
      );
      await writeFile(
        join(area.runDirectory, 'index.json'),
        JSON.stringify({
          ...read.artifact.index,
          cells: read.artifact.index.cells.map((cell) =>
            cell.cellId === first.cellId
              ? { ...cell, status: 'not-run' }
              : cell,
          ),
        }),
      );
      const output = await publish(
        area.root,
        area.runDirectory,
        join(area.directory, 'states'),
        1,
      );
      const evidence = objectsAt(output.parsed, 'evidence');
      const firstView = evidence.find(
        (cell) => textAt(cell, 'cellId') === first.cellId,
      );
      const secondView = evidence.find(
        (cell) => textAt(cell, 'cellId') === second.cellId,
      );
      expect(firstView).toMatchObject({
        status: 'published',
        attempts: [
          { responseText: '' },
          { responseText: null, sent: false, kind: 'repair' },
        ],
      });
      expect(secondView).toMatchObject({ attempts: [] });
      expect(output.parsed).toMatchObject({
        publication: { consistency: { indexReliable: false } },
      });
      expect(output.html).toContain('已保存空正文');
      expect(output.html).toContain('保存的模型响应：未保存正文');
      expect(output.html).toContain('发送前拒绝');
      expect(output.html).toContain('没有已保存的尝试');
      expect(output.html).toContain(
        'not-run / reviewed / index-record-status-disagreement',
      );
    });
  });
  it.each(['custom', 'project'] as const)(
    'omits plain private %s guidance and request/response/error echoes before publishing',
    async (kind) => {
      await withWorkflowArea(async (area) => {
        const workflow = area.plan.workflow;
        if (workflow === undefined) throw new Error('workflow missing');
        const privateText = 'INTERNAL_REPORT_NOTE_ONLY_132';
        const plan = {
          ...area.plan,
          workflow: {
            ...workflow,
            input: {
              customRules: kind === 'custom' ? privateText : '',
              projectRules:
                kind === 'project'
                  ? { kind: 'provided' as const, text: privateText }
                  : { kind: 'disabled' as const },
            },
          },
        };
        await area.write(plan);
        await writeFile(
          area.fixturePath,
          JSON.stringify(
            fixtureOf(
              Object.fromEntries(
                cellGrid(plan).cells.map((cell) => [
                  cell.cellId,
                  fixtureCell({
                    decision: [{ status: 200, body: privateText }],
                  }),
                ]),
              ),
            ),
          ),
        );
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const read = await readRun(
          area.runDirectory,
          await compileRunCheckers(),
          { allowWorkflow: true },
        );
        if (!read.ok) throw new Error(JSON.stringify(read.problems));
        const files: [string, string][] = [];
        for (const record of read.artifact.records) {
          const path = join(area.runDirectory, recordPathOf(record.cellId));
          await writeFile(
            path,
            JSON.stringify({
              ...record,
              attempts: record.attempts.map((attempt) => ({
                ...attempt,
                error: privateText,
              })),
            }),
          );
          files.push([path, await readFile(path, 'utf8')]);
        }
        expect(files.every(([, text]) => text.includes(privateText))).toBe(
          true,
        );
        const output = await publish(
          area.root,
          area.runDirectory,
          join(area.directory, 'private-report'),
        );
        for (const text of [output.json, output.markdown, output.html])
          expect(text).not.toContain(privateText);
        const evidence = objectsAt(output.parsed, 'evidence');
        expect(evidence).toHaveLength(2);
        for (const cell of evidence) {
          expect(cell).toMatchObject({
            status: 'omitted-private-context',
            materialText: null,
          });
          const attempts = objectsAt(cell, 'attempts');
          expect(attempts).toHaveLength(1);
          for (const attempt of attempts)
            expect(attempt).toMatchObject({
              requestText: null,
              responseText: null,
              errorText: null,
            });
        }
        expect(output.html).toContain('运行含私有指导');
        for (const [path, before] of files)
          expect(await readFile(path, 'utf8')).toBe(before);
      });
    },
  );

  it('keeps all three formats on the same planned statuses and preserves absent records', async () => {
    const fixture = await reportBrowserFixture();
    try {
      const json = await readJson(`${fixture.prefix}.json`);
      expect(json).toMatchObject({
        coverage: {
          cellsPlanned: 8,
          statuses: {
            unsupported: 4,
            reviewed: 1,
            'budget-exhausted': 1,
            'not-run': 2,
          },
        },
      });
      const html = await fixture.text('html');
      const markdown = await fixture.text('md');
      expect(markdown).toContain('| 计划格子 | 8 |');
      expect(html).toContain('<td>计划格子</td><td>8</td>');
      const rows = [
        ...html.matchAll(/<tr data-example[^>]*>(.*?)<\/tr>/gsu),
      ].map((match) => match[1] ?? '');
      for (const cell of fixture.report.examples) {
        const example = objectsAt(json, 'examples').find(
          (entry) => textAt(entry, 'cellId') === cell.cellId,
        );
        expect(example).toMatchObject({
          cellId: cell.cellId,
          status: cell.status,
        });
        expect(markdown).toContain(cell.cellId);
        expect(
          markdown
            .split('\n')
            .some(
              (line) =>
                line.includes(cell.cellId) &&
                line.includes(`| ${cell.status}/${cell.classification} |`),
            ),
        ).toBe(true);
        const row = rows.find((item) =>
          item.includes(`<td>${cell.cellId}</td>`),
        );
        expect(row).toContain(cell.status);
      }
      expect(rows).toHaveLength(8);
      const unrun = fixture.report.examples.filter(
        (cell) => cell.status === 'not-run',
      );
      expect(unrun).toHaveLength(2);
      expect(
        unrun.every((cell) =>
          rows
            .find((row) => row.includes(`<td>${cell.cellId}</td>`))
            ?.includes('没有已保存记录'),
        ),
      ).toBe(true);
    } finally {
      await fixture.remove();
    }
  });

  it('withholds stored body text if the frozen source disappears or saved configuration is unverified', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const read = await readRun(
        area.runDirectory,
        await compileRunCheckers(),
        { allowWorkflow: true },
      );
      if (!read.ok) throw new Error(JSON.stringify(read.problems));
      for (const record of read.artifact.records)
        await writeFile(
          join(area.runDirectory, recordPathOf(record.cellId)),
          JSON.stringify({
            ...record,
            attempts: record.attempts.map((attempt) => ({
              ...attempt,
              responseText: 'PUBLIC_AVAILABLE_BODY',
            })),
          }),
        );
      const available = await publish(
        area.root,
        area.runDirectory,
        join(area.directory, 'available'),
      );
      expect(available.html).toContain('PUBLIC_AVAILABLE_BODY');
      await rm(area.sourcePath);
      const missing = await publish(
        area.root,
        area.runDirectory,
        join(area.directory, 'missing'),
      );
      expect(missing.html).not.toContain('PUBLIC_AVAILABLE_BODY');
      expect(missing.json).toContain('unverified-context');
      await writeFile(
        area.sourcePath,
        JSON.stringify({ schemaVersion: 'grouped-v1', records: [area.source] }),
      );
      const saved = read.artifact.index.workflowExecution;
      if (saved === undefined) throw new Error('saved execution missing');
      await writeFile(
        join(area.runDirectory, 'index.json'),
        JSON.stringify({
          ...read.artifact.index,
          workflowExecution: {
            ...saved,
            config: { unexpectedPrivateField: 'INTERNAL_CONFIG_BODY_132' },
          },
        }),
      );
      const drift = await publish(
        area.root,
        area.runDirectory,
        join(area.directory, 'drift'),
      );
      expect(drift.json).toContain('unverified-context');
      expect(drift.html).not.toContain('PUBLIC_AVAILABLE_BODY');
      expect(drift.json).not.toContain('INTERNAL_CONFIG_BODY_132');
    });
  });

  it('withholds plain private legacy policy without changing the saved record', async () => {
    await withArea(async (area) => {
      const datasetPath = await unlabelledCoreDataset(area);
      const original = (await coreCases(datasetPath)).cases[0];
      if (original === undefined) throw new Error('legacy case missing');
      const privateText = 'LEGACY_INTERNAL_GUIDANCE_132';
      await area.write(`dataset/cases/${original.caseId}.json`, {
        ...original,
        input: {
          ...original.input,
          policy: { ...original.input.policy, customRules: privateText },
        },
      });
      const id = cellIdOf({
        caseId: original.caseId,
        targetId: 'chat-a',
        protocol: 'chat',
      });
      const directory = await runPlan({
        directory: join(area.path, 'run'),
        datasetPath,
        plan: planOf({ datasetPath, caseIds: [original.caseId] }),
        fixture: fixtureOf({
          [id]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
      });
      const path = join(directory, recordPathOf(id));
      const before = await readFile(path, 'utf8');
      expect(before).toContain(privateText);
      const output = await publish(
        REPOSITORY_ROOT,
        directory,
        join(area.path, 'report'),
      );
      expect(output.json).toContain('omitted-private-context');
      for (const text of [output.json, output.markdown, output.html])
        expect(text).not.toContain(privateText);
      expect(await readFile(path, 'utf8')).toBe(before);
    });
  });
});
