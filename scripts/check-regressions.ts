import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, '.local', 'regressions');
await mkdir(artifacts, { recursive: true });
// Keep the historical reproducer intact. This location has the same relative
// depth as its source, so its imports still exercise the current lib/ build.
const run = await mkdtemp(join(artifacts, 'run-'));
const script = join(run, 'reproduce.mjs');
await copyFile(
  join(root, 'validation/codex-review/2026-10-21/reproduce.mjs'),
  script,
);
const result = spawnSync(process.execPath, [script], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
if (result.signal !== null) {
  throw new Error(`Regression runner terminated with ${result.signal}.`);
}
process.stdout.write(`Regression evidence: ${join(run, 'results.json')}\n`);
process.exitCode = result.status ?? 1;
