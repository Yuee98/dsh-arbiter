import console from 'node:console';
import process from 'node:process';

// Keep this gate independent of pnpm and the pinned tool installation so it
// still reports failures when a dependency or tool setup job fails.
/** @type {unknown} */
const results = JSON.parse(process.env['CI_JOB_RESULTS'] ?? 'null');

if (!results || typeof results !== 'object' || Array.isArray(results)) {
  throw new Error('CI job results must be a nonempty object.');
}

const jobs = Object.keys(results);
if (jobs.length === 0) {
  throw new Error('CI job results must include every required job.');
}

let failed = false;
for (const name of jobs) {
  /** @type {unknown} */
  const job = Reflect.get(results, name);
  const result =
    job && typeof job === 'object' && 'result' in job ? job.result : undefined;
  console.log(`${name}: ${String(result)}`);
  if (result !== 'success') failed = true;
}
if (failed) process.exitCode = 1;
