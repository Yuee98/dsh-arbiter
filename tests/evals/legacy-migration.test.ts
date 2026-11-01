import { readFile, readdir, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { readDataset } from '../../evals/src/data/read.js';
import { readGroupedDataset } from '../../evals/src/data/group-read.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { migrateLegacy } from '../../evals/src/data/legacy-migrate.js';
import { withLegacy } from './helpers/legacy.js';
import { REPOSITORY_ROOT, withDataset } from './helpers/dataset.js';

const old = join(REPOSITORY_ROOT, 'evals/datasets/core-v1');
const current = { contract: 'review-contract-v1', rubric: 'review-rubric-v1' };
const checkers = await compileCheckers();

describe('legacy migration equivalence', () => {
  it('preserves every original object independently of conversion and keeps 51/49/2, 204, 16 and13/22/16', async () => {
    expect(
      spawnSync(
        'git',
        [
          'diff',
          '--exit-code',
          '28ee54f05a131b8cc4c1568e951fda5bbdc748d3',
          '--',
          'evals/datasets/core-v1',
        ],
        { cwd: REPOSITORY_ROOT },
      ).status,
    ).toBe(0);
    const loaded = inspectDataset(
      await readDataset(join(REPOSITORY_ROOT, 'evals/datasets/reviewer-v2')),
      checkers,
      current,
    );
    expect(loaded.problems).toEqual([]);
    expect(loaded.cases).toHaveLength(51);
    expect(loaded.labels.gold).toHaveLength(49);
    expect(loaded.labels.excluded.map((e) => e.reasons)).toEqual([
      ['no-score'],
      ['no-score'],
    ]);
    expect(loaded.manifest?.families).toHaveLength(16);
    expect(
      loaded.reviews.reduce((n, e) => n + e.document.reviews.length, 0),
    ).toBe(204);
    for (const [role, entries] of [
      ['cases', loaded.cases],
      [
        'labels',
        [...loaded.labels.gold, ...loaded.labels.excluded].map((e) => ({
          document: e.label,
        })),
      ],
      ['reviews', loaded.reviews],
    ] as const) {
      const originalFiles = await readdir(join(old, role));
      expect(entries).toHaveLength(originalFiles.length);
      for (const entry of entries)
        expect(entry.document).toEqual(
          JSON.parse(
            await readFile(
              join(old, role, `${entry.document.caseId}.json`),
              'utf8',
            ),
          ),
        );
    }
    expect(
      ['dev', 'calibration', 'holdout'].map(
        (split) =>
          loaded.cases.filter((e) => e.document.split === split).length,
      ),
    ).toEqual([13, 22, 16]);
    expect(loaded.cases[0]?.path).toMatch(/legacy-v1\/cases.json#\/records\//u);
  });
  it('refuses symlinked migration directories before publishing any collections', async () => {
    await withDataset(async (area) => {
      const target = join(area.path, 'target');
      const outside = join(area.path, 'outside');
      await mkdir(target);
      await mkdir(outside);
      await symlink(outside, join(target, 'dev'));
      await expect(migrateLegacy(old, target, true)).rejects.toThrow(
        'regular directory',
      );
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(target)).toEqual(['dev']);
    });
  });
  it('repeats without duplicates/byte changes and refuses overwriting an edited target', async () => {
    await withDataset(async (area) => {
      const target = join(area.path, 'migrated');
      const files = await migrateLegacy(old, target, true);
      expect(files).toHaveLength(9);
      const before = await Promise.all(
        files.map((p) => readFile(join(target, p), 'utf8')),
      );
      await migrateLegacy(old, target, true);
      await migrateLegacy(old, target, false);
      expect(
        await Promise.all(files.map((p) => readFile(join(target, p), 'utf8'))),
      ).toEqual(before);
      const file = join(target, 'dev/legacy-v1/cases.json');
      await writeFile(file, '{"schemaVersion":"grouped-v1","records":[]}');
      await expect(migrateLegacy(old, target, true)).rejects.toThrow(
        'refusing to overwrite',
      );
      expect(await readFile(file, 'utf8')).toContain('"records":[]');
    });
  });
  it('preserves explicit cross-split ID priority/order while keeping implicit dev isolated', async () => {
    await withLegacy(async (_root, dataset) => {
      const raw = await readDataset(dataset);
      const all = inspectDataset(raw, checkers, current);
      const holdout = all.cases.find((e) => e.document.split === 'holdout')
        ?.document.caseId;
      const dev = all.cases.find((e) => e.document.split === 'dev')?.document
        .caseId;
      if (holdout === undefined || dev === undefined)
        throw new Error('missing fixture split');
      const selected = inspectDataset(
        await readDataset(dataset, { split: 'dev', caseIds: [holdout, dev] }),
        checkers,
        current,
      );
      expect(selected.problems).toEqual([]);
      expect(new Set(selected.cases.map((e) => e.document.caseId))).toEqual(
        new Set([holdout, dev]),
      );
      await writeFile(join(dataset, 'holdout/legacy-v1/cases.json'), '{broken');
      expect(
        inspectDataset(
          await readDataset(dataset, { split: 'dev' }),
          checkers,
          current,
        ).cases,
      ).toHaveLength(13);
      expect(
        (await readDataset(dataset, { caseIds: [holdout] })).problems.length,
      ).toBeGreaterThan(0);
    });
  });
  it('does not adopt a policy version merely because every label claims it', async () => {
    await withLegacy(async (_root, dataset) => {
      const file = join(dataset, 'dev/legacy-v1/labels.json');
      const raw = await readDataset(dataset, { split: 'dev' });
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 'grouped-v1',
          records: raw.labels.map((e) => {
            const checked = checkers.label(e.document);
            if (!checked.ok) throw new Error('invalid fixture');
            return {
              ...checked.document,
              versions: {
                ...checked.document.versions,
                policy: 'wrong-policy',
              },
            };
          }),
        }),
      );
      expect(
        (await readGroupedDataset(dataset, { references: true })).problems.some(
          (e) => e.message.includes('version-drift'),
        ),
      ).toBe(true);
    });
  });
});
