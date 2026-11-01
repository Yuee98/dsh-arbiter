/** Run the production CLI router against an isolated repository root. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT } from './dataset.js';
export async function legacyAuthority(root: string): Promise<void> {
  for (const path of [
    'evals/rubrics/rubric-v1.json',
    'docs/milestones/review-quality-rubrics.md',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(REPOSITORY_ROOT, path), join(root, path));
  }
}
export function legacyCli(
  root: string,
  argv: readonly string[],
): ReturnType<typeof spawnSync> {
  const moduleUrl = (path: string) =>
    pathToFileURL(join(REPOSITORY_ROOT, path)).href;
  const source = `import ${JSON.stringify(moduleUrl('evals/src/cli/register.ts'))}; const {runGroupedCli}=await import(${JSON.stringify(moduleUrl('evals/src/data/group-command.ts'))}); const {runCli}=await import(${JSON.stringify(moduleUrl('evals/src/cli/run.ts'))}); const io={root:${JSON.stringify(root)},out:console.log,err:console.error}; const argv=${JSON.stringify(argv)}; process.exitCode=(await runGroupedCli(argv,io,runCli)) ?? (await runCli(argv,io));`;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { cwd: root, encoding: 'utf8', timeout: 15_000 },
  );
}
