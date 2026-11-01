/** Lossless, repeatable conversion. A changed target is never overwritten. */
import { mkdir, readFile, link, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDataset } from './read.js';
import { compileCheckers } from './schemas.js';
import { inspectDataset } from './inspect.js';
import { canonicalJson } from './hash.js';
import { legacyMetadata } from './legacy-metadata.js';
import { destinationsInside } from '../report/write.js';

async function assertDirectories(destination: string): Promise<void> {
  for (const relative of [
    '',
    ...['dev', 'calibration', 'holdout'].flatMap((split) => [
      split,
      `${split}/legacy-v1`,
    ]),
  ]) {
    const path = join(destination, relative);
    try {
      if (!(await lstat(path)).isDirectory())
        throw new Error(
          `migration directory must be a regular directory: ${path}`,
        );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
}

export async function migrateLegacy(
  source: string,
  destination: string,
  write: boolean,
): Promise<readonly string[]> {
  if (
    destinationsInside(
      [resolve(destination)],
      [{ path: resolve(source), kind: 'directory' }],
    ).length > 0
  )
    throw new Error(
      'migration destination would modify protected historical source',
    );
  const meta = await legacyMetadata();
  const checked = inspectDataset(
    await readDataset(source),
    await compileCheckers(),
    { contract: meta.versions.contract, rubric: meta.versions.rubric },
  );
  if (checked.problems.length > 0 || checked.manifest?.datasetId !== 'core-v1')
    throw new Error(
      `migration requires a valid historical core-v1: ${checked.problems.map((p) => p.message).join('; ')}`,
    );
  const documents = new Map<string, string>();
  for (const split of ['dev', 'calibration', 'holdout'] as const) {
    const cases = checked.cases
      .filter((e) => e.document.split === split)
      .map((e) => e.document);
    const ids = new Set(cases.map((c) => c.caseId));
    for (const [role, records] of [
      ['cases', cases],
      [
        'labels',
        [...checked.labels.gold, ...checked.labels.excluded]
          .map((e) => e.label)
          .filter((l) => ids.has(l.caseId)),
      ],
      [
        'opinions',
        checked.reviews.map((e) => e.document).filter((r) => ids.has(r.caseId)),
      ],
    ] as const) {
      documents.set(
        `${split}/legacy-v1/${role}.json`,
        JSON.stringify(
          {
            schemaVersion: 'grouped-v1',
            records: [...records].sort((a, b) =>
              a.caseId.localeCompare(b.caseId),
            ),
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
  const absent: string[] = [];
  await assertDirectories(destination);
  for (const [relative, expected] of documents) {
    const path = join(destination, relative);
    try {
      if (!(await lstat(path)).isFile())
        throw new Error(`${relative}: target is not a regular file`);
      const actual: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (canonicalJson(actual) !== canonicalJson(JSON.parse(expected)))
        throw new Error(
          `${relative}: target differs from historical source; refusing to overwrite`,
        );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        absent.push(relative);
      else throw error;
    }
  }
  if (!write && absent.length > 0)
    throw new Error(`migration incomplete: ${absent.join(', ')}`);
  for (const relative of absent) {
    const path = join(destination, relative);
    await mkdir(dirname(path), { recursive: true });
    await assertDirectories(destination);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, documents.get(relative) ?? '', {
        encoding: 'utf8',
        flag: 'wx',
      });
      await link(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return [...documents.keys()];
}
