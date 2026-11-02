/** Actual legacy runner/report IO; workflow runner integration remains a separate #176 gate. */
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reportRun } from '../../evals/src/report/command.js';
import { buildReport, defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { workflowReferences } from '../../evals/src/annotation/workflow-service.js';
import { DEFAULT_ANNOTATION_CONTEXT } from '../../evals/src/annotation/workflow-view.js';
import { withArea, runPlan } from '../evals/helpers/report-run.js';
import type { Area } from '../evals/helpers/report-run.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from '../evals/helpers/run.js';
import {
  approvedTarget,
  manifest,
  reviewCase,
  reviewLabel,
} from '../evals/fixtures/documents.js';
import { collectionOf, workflow } from '../evals/fixtures/workflow.js';

async function syntheticRun(
  created: Area,
): Promise<{ directory: string; dataset: string }> {
  const entry = reviewCase();
  await created.write('dataset/manifest.json', manifest(['case-a']));
  await created.write('dataset/cases/case-a.json', entry);
  await created.write(
    'dataset/labels/case-a.json',
    reviewLabel(inputHashOf(entry.input), {
      target: approvedTarget({
        allowed: { risk: [3], authorization: [10] },
        behaviourReference: 'deny',
        rationale: '<img src=x onerror=alert(1)> synthetic reference',
      }),
    }),
  );
  const dataset = join(created.path, 'dataset');
  const plan = planOf({
    datasetId: 'synthetic',
    datasetPath: dataset,
    caseIds: ['case-a'],
    targets: [chatTarget()],
  });
  const fixture = fixtureOf({
    [cellIdOf({ caseId: 'case-a', targetId: 'chat-a', protocol: 'chat' })]:
      fixtureCell({ chat: [chatAnswer(3, 10)] }),
  });
  const directory = await runPlan({
    directory: join(created.path, 'run'),
    datasetPath: dataset,
    plan,
    fixture,
  });
  return { directory, dataset };
}
async function runReport(
  created: Area,
  directory: string,
  dataset: string,
  output: string,
  references: readonly string[] = [],
): Promise<number> {
  return reportRun(
    { root: created.path, out: () => {}, err: () => {} },
    {
      directory,
      dataset,
      output,
      references,
      mode: 'ask',
      channel: 'available',
      force: true,
    },
  );
}

describe('report denominator and evidence IO', () => {
  it('rebuilds JSON/MD/HTML deterministically through the real offline report command', async () => {
    await withArea(async (created) => {
      const { directory, dataset } = await syntheticRun(created);
      const forbiddenFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('report must stay offline'));
      try {
        const read = await observeRun({
          directory,
          root: created.path,
          dataset: { kind: 'path', path: dataset },
        });
        if (!read.ok) throw new Error(read.problems.join('; '));
        const report = buildReport({
          observation: read.observation,
          settings: defaultSettings(created.path),
        });
        expect(report.quality?.overall).toMatchObject({
          conditional: {
            falseAllow: { numerator: 1, denominator: 1, rate: 1 },
          },
          pairs: { labeled: 1, exactPair: 1 },
        });
        expect(report.diagnostics.labels).toMatchObject({
          gold: 1,
          authorityConflict: 0,
        });
        const prefix = join(created.path, 'report');
        expect(await runReport(created, directory, dataset, prefix)).toBe(0);
        const before = await Promise.all(
          ['json', 'md', 'html'].map((extension) =>
            readFile(`${prefix}.${extension}`, 'utf8'),
          ),
        );
        expect(JSON.parse(before[0] ?? '') as unknown).toMatchObject({
          quality: {
            identities: { legacyCases: 1, roots: 0 },
            overall: {
              conditional: { falseAllow: { numerator: 1, denominator: 1 } },
            },
          },
          examples: [
            {
              classification: 'false-allow',
              source: { kind: 'legacy', caseId: 'case-a' },
            },
          ],
        });
        expect(before[1]).toContain('100.0% (1/1)');
        expect(before[1]).toContain('全计划身份与参考明细');
        expect(before[2]).toContain('100.0% (1/1)');
        expect(before[2]).not.toContain('<img');
        expect(before[2]).toContain('&lt;img');
        expect(await runReport(created, directory, dataset, prefix)).toBe(0);
        expect(
          await Promise.all(
            ['json', 'md', 'html'].map((extension) =>
              readFile(`${prefix}.${extension}`, 'utf8'),
            ),
          ),
        ).toEqual(before);
        expect(forbiddenFetch).not.toHaveBeenCalled();
      } finally {
        forbiddenFetch.mockRestore();
      }
    });
  });
  it('protects all grouped role files even when the selected dataset is unreadable', async () => {
    await withArea(async (created) => {
      const { directory } = await syntheticRun(created);
      const dataset = await created.dir('damaged-dataset');
      for (const role of ['workflows', 'labels', 'opinions', 'authoring']) {
        const relative = `damaged-dataset/dev/f01/${role}.json`;
        await created.write(relative, { syntheticEvidence: role });
        const path = join(created.path, relative);
        const before = await readFile(path, 'utf8');
        expect(
          await runReport(created, directory, dataset, path.slice(0, -5)),
        ).toBe(1);
        expect(await readFile(path, 'utf8')).toBe(before);
      }
      const source = join(dataset, 'dev/f01/workflows.json');
      await symlink(source, join(created.path, 'alias.json'));
      const original = await readFile(source, 'utf8');
      expect(
        await runReport(
          created,
          directory,
          dataset,
          join(created.path, 'alias'),
        ),
      ).toBe(1);
      expect(await readFile(source, 'utf8')).toBe(original);
    });
  });
  it('protects an explicit #127 frozen snapshot and rejects malformed snapshots without writing', async () => {
    await withArea(async (created) => {
      const { directory, dataset } = await syntheticRun(created);
      await created.write(
        'workflow-data/dev/f01/workflows.json',
        collectionOf(workflow()),
      );
      const snapshot = await workflowReferences({
        root: created.path,
        dataset: join(created.path, 'workflow-data'),
        split: 'dev',
        group: 'f01',
        context: DEFAULT_ANNOTATION_CONTEXT,
      });
      await created.write('reference.json', snapshot);
      const path = join(created.path, 'reference.json');
      const before = await readFile(path, 'utf8');
      expect(
        await runReport(
          created,
          directory,
          dataset,
          join(created.path, 'reference'),
          [path],
        ),
      ).toBe(1);
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(
        await runReport(
          created,
          directory,
          dataset,
          join(created.path, 'report-with-reference'),
          [path],
        ),
      ).toBe(0);
      await created.write('invalid.json', {
        snapshotVersion: 'workflow-annotation-v1',
        retryKey: 'private-sentinel',
      });
      expect(
        await runReport(
          created,
          directory,
          dataset,
          join(created.path, 'invalid-report'),
          [join(created.path, 'invalid.json')],
        ),
      ).toBe(1);
      await expect(
        readFile(join(created.path, 'invalid-report.json')),
      ).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(before);
    });
  });
});
