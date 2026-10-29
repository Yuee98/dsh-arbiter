import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  historicalVerdict,
  parseCases,
  retiredVerdict,
  scopeVerdict,
} from './regression-verdict.ts';
import type { RunVerdict } from './regression-verdict.ts';
import {
  RETIRED_ENGINE_SYMBOLS,
  symbolLabel,
  type EngineProbeReport,
  type RetiredEngineModule,
} from './retired-engine.ts';

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

/**
 * Which of the retired engine's symbols this build still exports.
 *
 * The probe imports the built library exactly as the frozen script does, so a
 * module that fails to load is reported as unreadable rather than as "absent".
 * Those two are different facts: absent means the symbol is gone, unreadable means
 * this build cannot be inspected at all, and only the first can retire a run.
 */
async function probeEngine(): Promise<EngineProbeReport> {
  const absent: string[] = [];
  const present: string[] = [];
  const unreadable: string[] = [];
  const modules = new Map<RetiredEngineModule, Record<string, unknown>>();
  for (const name of ['policy', 'reviewer'] as const) {
    try {
      const namespace: unknown = await import(
        new URL(`../lib/${name}.js`, import.meta.url).href
      );
      if (!isRecord(namespace))
        throw new TypeError('the built module exported no namespace');
      modules.set(name, namespace);
    } catch (error) {
      unreadable.push(
        `${name} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  for (const entry of RETIRED_ENGINE_SYMBOLS) {
    const namespace = modules.get(entry.module);
    if (namespace === undefined) continue;
    const label = symbolLabel(entry);
    (entry.symbol in namespace ? present : absent).push(label);
  }
  return { absent, present, unreadable };
}

/** A module namespace or any object, narrowed without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
    // A missing report is only excused for the historical run, and only when the
    // probe proves the engine it imports is gone. Every other missing report —
    // including the scope run's — is a failure, because a script that crashed for
    // an unrelated reason also leaves no file behind.
    const retired =
      run.name === 'R1–R9' ? retiredVerdict(await probeEngine()) : null;
    if (retired !== null && retired.retired) {
      process.stdout.write(
        `R1–R9: retired with the legacy engine; the frozen script imports symbols this build no longer exports, so it cannot run. ` +
          'The script and its recorded results stay unmodified as prototype evidence.\n',
      );
      continue;
    }
    failedRuns += 1;
    process.stderr.write(
      retired === null
        ? `${run.name}: results.json is unreadable\n`
        : `${run.name}: results.json is unreadable and the run is not retired: ${retired.problems.join('; ')}\n`,
    );
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
