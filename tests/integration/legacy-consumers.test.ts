import { cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyAuthority, legacyCli } from '../evals/helpers/legacy-cli.js';
import { withLegacy, fillBatch } from '../evals/helpers/legacy.js';
import { REPOSITORY_ROOT } from '../evals/helpers/dataset.js';
import {
  planOf,
  fixtureOf,
  fixtureCell,
  cellIdOf,
  chatAnswer,
} from '../evals/helpers/run.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { loadCases, loadDefinition } from '../../evals/src/experiments/load.js';

const first = 'read-named-source-file';
async function run(
  root: string,
  dataset: string,
  ids: readonly string[] = [first],
): Promise<string> {
  await legacyAuthority(root);
  const plan = planOf({
    datasetId: 'legacy-v1',
    datasetPath: dataset,
    caseIds: ids,
  });
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan));
  await writeFile(
    join(root, 'fixture.json'),
    JSON.stringify(
      fixtureOf(
        Object.fromEntries(
          ids.map((caseId) => [
            cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
            fixtureCell({ chat: [chatAnswer(1, 10)] }),
          ]),
        ),
      ),
    ),
  );
  const command = legacyCli(root, ['run', 'plan.json', '--dir', 'run']);
  expect(command.stderr.toString()).not.toContain('problem');
  expect(command.status).toBe(0);
  return join(root, 'run');
}

describe('legacy consumer entry points', () => {
  it('uses selected dev without opening broken holdout, and honors ordered explicit cross-split IDs in run/report/experiment', async () => {
    await withLegacy(async (root, dataset) => {
      const raw = await compileCheckers();
      const hold = raw.groupedCases(
        JSON.parse(
          await readFile(join(dataset, 'holdout/legacy-v1/cases.json'), 'utf8'),
        ),
      );
      if (!hold.ok) throw new Error(hold.problems.join('; '));
      const id = hold.document.records[0]?.caseId;
      if (id === undefined) throw new Error('missing fixture');
      await run(root, dataset, [id, first]);
      const report = legacyCli(root, [
        'report',
        'run',
        '--out',
        '.local/cross',
      ]);
      expect(report.status).toBe(0);
      expect(report.stdout.toString()).toContain('labels gold 2');
      const frozen: unknown = JSON.parse(
        await readFile(join(root, 'run/plan.json'), 'utf8'),
      );
      expect(frozen).toMatchObject({ caseIds: [id, first] });
      const definition = await loadDefinition(
        join(REPOSITORY_ROOT, 'evals/experiments/rq14-matrix.json'),
      );
      if (!definition.ok) throw new Error(definition.problems.join('; '));
      const selected = await loadCases(
        { root, err: () => undefined },
        {
          ...definition.definition,
          dataset: {
            ...definition.definition.dataset,
            datasetId: 'legacy-v1',
            datasetPath: dataset,
            split: 'dev',
            caseIds: [id, first],
          },
        },
      );
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error(selected.problems.join('; '));
      expect(selected.cases.map((e) => e.caseId)).toEqual([id, first]);
      await writeFile(join(dataset, 'holdout/legacy-v1/cases.json'), '{broken');
      const plan = planOf({
        datasetId: 'legacy-v1',
        datasetPath: dataset,
      });
      await writeFile(
        join(root, 'dev.json'),
        JSON.stringify(plan, (key, value: unknown) =>
          key === 'caseIds' ? undefined : value,
        ),
      );
      const devCases = raw.groupedCases(
        JSON.parse(
          await readFile(join(dataset, 'dev/legacy-v1/cases.json'), 'utf8'),
        ),
      );
      if (!devCases.ok) throw new Error(devCases.problems.join('; '));
      await writeFile(
        join(root, 'fixture.json'),
        JSON.stringify(
          fixtureOf(
            Object.fromEntries(
              devCases.document.records.map(({ caseId }) => [
                cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
                fixtureCell({ chat: [chatAnswer(1, 10)] }),
              ]),
            ),
          ),
        ),
      );
      const dev = legacyCli(root, ['plan', 'dev.json']);
      expect(dev.stderr.toString()).not.toContain('problem');
      expect(dev.status).toBe(0);
      expect(dev.stdout.toString()).toContain('13');
    });
  }, 30_000);
  it('retains adverse independent behaviour while still excluding structurally invalid collection labels', async () => {
    await withLegacy(async (root, dataset) => {
      await run(root, dataset);
      const path = join(dataset, 'dev/legacy-v1/labels.json');
      const parsed = (await compileCheckers()).groupedLabels(
        JSON.parse(await readFile(path, 'utf8')),
      );
      if (!parsed.ok) throw new Error(parsed.problems.join('; '));
      await writeFile(
        path,
        JSON.stringify({
          ...parsed.document,
          records: parsed.document.records.map((e) =>
            'caseId' in e && e.caseId === first
              ? { ...e, target: { ...e.target, behaviourReference: 'deny' } }
              : e,
          ),
        }),
      );
      const report = legacyCli(root, [
        'report',
        'run',
        '--out',
        '.local/invalid',
      ]);
      expect(report.status).toBe(0);
      expect(report.stdout.toString()).toContain('labels gold 1');
      expect(report.stdout.toString()).toContain('behaviour 1 compared of 1');
      const observation = await observeRun({
        root,
        directory: join(root, 'run'),
        dataset: { kind: 'path', path: dataset },
      });
      if (!observation.ok) throw new Error(observation.problems.join('; '));
      expect(observation.observation.dataset.contestedCases.has(first)).toBe(
        false,
      );
      expect(observation.observation.dataset.findings.join('; ')).toContain(
        'behaviour reference',
      );
      await writeFile(
        path,
        JSON.stringify({
          ...parsed.document,
          records: parsed.document.records.map((entry) =>
            'caseId' in entry && entry.caseId === first
              ? {
                  ...entry,
                  target: {
                    ...entry.target,
                    allowed: { risk: [1], authorization: [10] },
                    allowedPairs: [[2, 10]],
                    behaviourReference: 'allow',
                  },
                }
              : entry,
          ),
        }),
      );
      const invalid = legacyCli(root, [
        'report',
        'run',
        '--out',
        '.local/structural',
      ]);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout.toString()).toContain('labels gold 0');
      expect(invalid.stdout.toString()).toContain('behaviour 0 compared of 1');
      const structural = await observeRun({
        root,
        directory: join(root, 'run'),
        dataset: { kind: 'path', path: dataset },
      });
      if (!structural.ok) throw new Error(structural.problems.join('; '));
      expect(structural.observation.dataset.contestedCases.has(first)).toBe(
        true,
      );
      expect(structural.observation.dataset.problems.join('; ')).toContain(
        'outside the allowed sets',
      );
    });
  }, 30_000);
  it.each([
    ['case', 'data/dev/legacy-v1/cases.json'],
    ['label', 'data/dev/legacy-v1/labels.json'],
    ['opinion', 'data/holdout/legacy-v1/opinions.json'],
    ['historical case', `evals/datasets/core-v1/cases/${first}.json`],
    ['historical pack', 'evals/annotation-pack/core-v1.pack.json'],
    ['file alias', 'alias.json'],
    ['directory alias', 'alias/labels.json'],
  ])(
    'refuses export/report source overwrite: %s',
    async (kind, path) => {
      await withLegacy(async (root, dataset) => {
        await run(root, dataset);
        const target = join(root, path);
        if (kind === 'file alias')
          await symlink(join(dataset, 'dev/legacy-v1/labels.json'), target);
        else if (kind === 'directory alias')
          await symlink(join(dataset, 'dev/legacy-v1'), join(root, 'alias'));
        else if (kind.startsWith('historical')) {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, 'historical evidence');
        }
        await writeFile(join(dataset, 'dev/legacy-v1/cases.json'), '{broken');
        const before = await readFile(target, 'utf8');
        const exported = legacyCli(root, ['export', dataset, '--out', target]);
        expect(exported.status).toBe(1);
        expect(exported.stderr.toString()).toContain(
          'protected source evidence',
        );
        const reported = legacyCli(root, [
          'report',
          'run',
          '--out',
          target.slice(0, -5),
          '--force',
        ]);
        expect(reported.status).toBe(1);
        expect(reported.stderr.toString()).toContain('evidence');
        expect(await readFile(target, 'utf8')).toBe(before);
      });
    },
    30_000,
  );
  it('protects old export sources and keeps normal report output usable', async () => {
    await withLegacy(async (root, dataset) => {
      await run(root, dataset);
      const old = join(root, 'evals/datasets/core-v1');
      await cp(join(REPOSITORY_ROOT, 'evals/datasets/core-v1'), old, {
        recursive: true,
      });
      const target = join(old, `labels/${first}.json`);
      const before = await readFile(target, 'utf8');
      const refused = legacyCli(root, ['export', old, '--out', target]);
      expect(refused.status).toBe(1);
      expect(refused.stderr.toString()).toContain('protected source evidence');
      expect(await readFile(target, 'utf8')).toBe(before);
      const normal = legacyCli(root, [
        'report',
        'run',
        '--out',
        '.local/ordinary',
        '--force',
      ]);
      expect(normal.status).toBe(0);
      expect(normal.stdout.toString()).toContain('wrote');
    });
  }, 30_000);
  it('routes a normal blind export and one-case import to the collection writer', async () => {
    await withLegacy(async (root, dataset) => {
      const file = join(root, '.local/fill.json');
      expect(legacyCli(root, ['export', dataset, '--out', file]).status).toBe(
        0,
      );
      await fillBatch(file, first, 'CLI fixture decision');
      const imported = legacyCli(root, [
        'import',
        dataset,
        '--fill',
        file,
        '--write',
      ]);
      expect(imported.status).toBe(0);
      expect(imported.stdout.toString()).toContain('wrote 1 legacy labels');
      expect(
        await readFile(join(dataset, 'dev/legacy-v1/labels.json'), 'utf8'),
      ).toContain('CLI fixture decision');
    });
  }, 30_000);
});
