/**
 * Offline evals checks.
 *
 * Two claims are checked here, and nothing else is:
 *
 *   1. the committed schemas compile, and the rubric snapshot still describes the
 *      shared review contract's bands;
 *   2. every published dataset is internally consistent — its cases, labels,
 *      reviews and manifest agree, and each label is bound to the input it judged.
 *
 * No model is called, no network is used and nothing is written. Real runs are a
 * separate, explicitly invoked command, so `pnpm verify` can stay offline.
 *
 * Publishing a dataset is a separate deliverable, so a repository with none is not a
 * failure here. It is not a pass either: the note names what was checked, so "the
 * schemas compile" is never read as "the data agrees".
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = `${root}evals/src/cli.ts`;

// The CLI installs the loader hook that lets it import the shared contract from
// source; running it as a child process keeps this check on exactly the path a
// person invokes, instead of a second wiring that could drift from it.
const result = spawnSync(process.execPath, [cli, 'check-all'], {
  cwd: root,
  encoding: 'utf8',
});

if (result.error !== undefined) throw result.error;
if (result.signal !== null) {
  throw new Error(`evals check terminated with ${result.signal}.`);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(
    `evals check failed with exit code ${String(result.status)}.`,
  );
}
// The CLI prints one line per dataset it actually checked, so this summary does not
// claim more than that: with no dataset published it says so rather than "passed".
process.stdout.write('Evals offline checks completed.\n');
