import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  historicalVerdict,
  parseCases,
  scopeVerdict,
} from './regression-verdict.ts';
import type { RunVerdict } from './regression-verdict.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, '.local', 'regressions');
await mkdir(artifacts, { recursive: true });

const runs: readonly {
  readonly name: string;
  readonly source: string;
  readonly verdict: (
    cases: readonly {
      readonly id: string;
      readonly passes: boolean;
      readonly actual: unknown;
    }[],
  ) => RunVerdict;
}[] = [
  {
    name: 'R1–R9',
    source: 'validation/codex-review/2026-10-21/reproduce.mjs',
    verdict: historicalVerdict,
  },
  {
    name: 'S1–S3',
    source: 'validation/first-release-scope/2026-10-25/reproduce.mjs',
    verdict: scopeVerdict,
  },
];

/** Read a runner report as untrusted JSON; null when unreadable or malformed. */
function readReport(path: string): ReturnType<typeof parseCases> {
  try {
    return parseCases(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

let failedRuns = 0;
for (const run of runs) {
  const directory = await mkdtemp(join(artifacts, 'run-'));
  const script = join(directory, 'reproduce.mjs');
  await copyFile(join(root, run.source), script);
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`${run.name} runner terminated with ${result.signal}.`);
  }
  process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);

  const reportPath = join(directory, 'results.json');
  const cases = readReport(reportPath);
  if (cases === null) {
    failedRuns += 1;
    process.stderr.write(`${run.name}: results.json is unreadable\n`);
    continue;
  }
  const verdict = run.verdict(cases);
  if (!verdict.ok) {
    failedRuns += 1;
    process.stderr.write(
      `${run.name} failed: ${verdict.problems.join('; ')}\n`,
    );
  } else if (run.name === 'R1–R9') {
    // R8's own summary line reads FAIL because the prototype flow it describes
    // no longer exists. The gate above replaced a name-based exemption with the
    // observation checks, so state what was actually verified.
    process.stdout.write(
      'R1–R9: R1–R7 and R9 passed, and R8 recorded the expected end state ' +
        '(candidate pending, no rule added, accept route unreachable)\n',
    );
  } else {
    process.stdout.write(
      `${run.name}: observations match the current contract\n`,
    );
  }
  process.stdout.write(`Regression evidence (${run.name}): ${reportPath}\n`);
}

process.exitCode = failedRuns === 0 ? 0 : 1;
