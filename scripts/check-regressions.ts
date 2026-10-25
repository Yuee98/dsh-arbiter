import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, '.local', 'regressions');
await mkdir(artifacts, { recursive: true });

interface Report {
  readonly results: readonly { readonly id: string; readonly passes: boolean }[];
}

/**
 * Two independent runners, each copied to the same relative depth as its source
 * so its `../../../lib/...` imports exercise the current build.
 *
 * 1. The historical R1–R9 reproducer stays byte-identical as evidence of the
 *    prototype's behavior. R8 covers an accept flow the first release removes,
 *    so its recorded failure is expected and named explicitly.
 * 2. The first-release scope runner states the current contract: suggestion
 *    endpoints are absent, an attempted acceptance changes nothing, and rules,
 *    rule testing and logs keep working with existing rows retained.
 */
const runs = [
  {
    name: 'R1–R9',
    source: 'validation/codex-review/2026-10-21/reproduce.mjs',
    // R8's historical expectation no longer matches the current contract.
    allowedFailures: ['R8'],
  },
  {
    name: 'S1–S3',
    source: 'validation/first-release-scope/2026-10-25/reproduce.mjs',
    allowedFailures: [] as string[],
  },
];

let failedRuns = 0;
for (const run of runs) {
  const directory = await mkdtemp(join(artifacts, 'run-'));
  const script = join(directory, 'reproduce.mjs');
  await copyFile(join(root, run.source), script);
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`${run.name} runner terminated with ${result.signal}.`);
  }

  const reportPath = join(directory, 'results.json');
  let report: Report | null = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  } catch {
    report = null;
  }
  const failed =
    report === null
      ? null
      : report.results.filter((entry) => !entry.passes).map((entry) => entry.id);
  const unexpected =
    failed === null
      ? result.status === 0
        ? []
        : ['<unreadable result>']
      : failed.filter((id) => !run.allowedFailures.includes(id));
  if (unexpected.length > 0) {
    failedRuns += 1;
    process.stderr.write(
      `${run.name} failed unexpectedly: ${unexpected.join(', ')}\n`,
    );
  }
  for (const id of run.allowedFailures.filter((value) => failed?.includes(value))) {
    process.stdout.write(
      `${run.name}: ${id} covers a prototype flow removed from the first release (documented historical evidence)\n`,
    );
  }
  process.stdout.write(
    `Regression evidence (${run.name}): ${reportPath}\n`,
  );
}

process.exitCode = failedRuns === 0 ? 0 : 1;
