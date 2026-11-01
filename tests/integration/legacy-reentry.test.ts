import { cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLegacy } from '../evals/helpers/legacy.js';
import { legacyAuthority, legacyCli } from '../evals/helpers/legacy-cli.js';
import { REPOSITORY_ROOT } from '../evals/helpers/dataset.js';
import { readDataset } from '../../evals/src/data/read.js';
import { readGroupedDataset } from '../../evals/src/data/group-read.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';

const first = 'read-named-source-file';
const current = { contract: 'review-contract-v1', rubric: 'review-rubric-v1' };
async function publishedRoot(root: string): Promise<string> {
  await legacyAuthority(root);
  for (const path of ['evals/datasets', 'evals/experiments']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(REPOSITORY_ROOT, path), join(root, path), {
      recursive: true,
    });
  }
  return join(root, 'evals/datasets/reviewer-v2');
}
describe('post-handoff legacy routing and authority regressions', () => {
  it('preserves mixed-layout single-document exports and historical pack validation', async () => {
    await withLegacy(async (root) => {
      await legacyAuthority(root);
      const dataset = join(root, 'example');
      await cp(
        join(REPOSITORY_ROOT, 'evals/datasets/format-example'),
        dataset,
        { recursive: true },
      );
      const file = join(root, 'example.pack.json');
      const exported = legacyCli(root, ['export', dataset, '--out', file]);
      expect(exported.status).toBe(0);
      expect(exported.stdout.toString()).toContain('2 blank entries');
      const pack = (await compileCheckers()).annotation(
        JSON.parse(await readFile(file, 'utf8')),
      );
      expect(pack.ok).toBe(true);
      if (!pack.ok) throw new Error(pack.problems.join('; '));
      expect(pack.document.datasetId).toBe('format-example');
      const imported = legacyCli(root, ['import', dataset, '--fill', file]);
      expect(imported.status).toBe(0);
      expect(imported.stdout.toString()).toContain('0 labels are ready');
      await writeFile(join(dataset, 'manifest.json'), '{broken');
      const invalid = legacyCli(root, [
        'export',
        dataset,
        '--out',
        join(root, 'invalid.json'),
      ]);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr.toString()).toContain('manifest.json');
      expect(invalid.stderr.toString()).not.toContain(
        'manifest declares case read-',
      );
      await rm(join(dataset, 'manifest.json'));
      await symlink(
        join(root, 'missing-manifest.json'),
        join(dataset, 'manifest.json'),
      );
      const dangling = legacyCli(root, [
        'export',
        dataset,
        '--out',
        join(root, 'dangling.json'),
      ]);
      expect(dangling.status).toBe(1);
      expect(dangling.stderr.toString()).toContain('manifest.json');
      expect(dangling.stderr.toString()).not.toContain(
        'manifest declares case read-',
      );
      await expect(readFile(join(root, 'dangling.json'))).rejects.toThrow();
    });
  }, 30_000);
  it.each(['missing', 'foreign', 'family', 'split'] as const)(
    'rejects %s migrated membership through check-all and consumer inspection',
    async (kind) => {
      await withLegacy(async (root) => {
        const dataset = await publishedRoot(root);
        const before = legacyCli(root, ['check-all']);
        expect(before.status).toBe(0);
        const raw = inspectDataset(
          await readDataset(dataset, { split: 'dev' }),
          await compileCheckers(),
          current,
        );
        if (raw.problems.length)
          throw new Error(raw.problems.map((p) => p.message).join('; '));
        const cases = raw.cases.map((e) => e.document);
        if (kind === 'split')
          await rm(join(dataset, 'dev/legacy-v1'), { recursive: true });
        else {
          const changed = cases.flatMap((c) =>
            c.caseId !== first
              ? [c]
              : kind === 'missing'
                ? []
                : [
                    {
                      ...c,
                      ...(kind === 'foreign'
                        ? { caseId: 'foreign-case' }
                        : { familyId: 'dev-routine-cleanup' }),
                    },
                  ],
          );
          await writeFile(
            join(dataset, 'dev/legacy-v1/cases.json'),
            JSON.stringify({ schemaVersion: 'grouped-v1', records: changed }),
          );
          if (kind !== 'family') {
            const labels = [...raw.labels.gold, ...raw.labels.excluded].flatMap(
              (e) =>
                e.label.caseId !== first
                  ? [e.label]
                  : kind === 'missing'
                    ? []
                    : [{ ...e.label, caseId: 'foreign-case' }],
            );
            const opinions = raw.reviews.flatMap((e) =>
              e.document.caseId !== first
                ? [e.document]
                : kind === 'missing'
                  ? []
                  : [{ ...e.document, caseId: 'foreign-case' }],
            );
            await writeFile(
              join(dataset, 'dev/legacy-v1/labels.json'),
              JSON.stringify({ schemaVersion: 'grouped-v1', records: labels }),
            );
            await writeFile(
              join(dataset, 'dev/legacy-v1/opinions.json'),
              JSON.stringify({
                schemaVersion: 'grouped-v1',
                records: opinions,
              }),
            );
          }
        }
        const checked = legacyCli(root, ['check-all']);
        expect(checked.status).toBe(1);
        expect(checked.stderr.toString()).toContain(
          kind === 'split' ? 'dev/legacy-v1' : first,
        );
        const consumer = inspectDataset(
          await readDataset(dataset, { split: 'dev' }),
          await compileCheckers(),
          current,
        );
        expect(consumer.problems.length).toBeGreaterThan(0);
        expect(
          (
            await readGroupedDataset(dataset, {
              split: 'calibration',
              references: true,
            })
          ).problems,
        ).toEqual([]);
      });
    },
    30_000,
  );
});
