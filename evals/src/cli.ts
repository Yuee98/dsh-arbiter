/**
 * The evals command line.
 *
 * The first import is the loader hook, and every other module is loaded after it so
 * that imports of the shared review contract resolve from source. See
 * `cli/register.ts` for why that is needed at all.
 *
 * There is no network call and no model call in this entry point: every command here
 * reads and writes committed JSON. Running real reviews belongs to the runner task,
 * which invokes it explicitly.
 */

import './cli/register.ts';

const { runCli } = await import('./cli/run.js');

const argv = process.argv.slice(2);
const askedForHelp =
  argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help';
process.exitCode = await runCli(argv, {
  root: new URL('../../', import.meta.url).pathname,
  out: (line: string) => process.stdout.write(`${line}\n`),
  err: (line: string) => process.stderr.write(`${line}\n`),
});
// Help is a successful request for information, not a misuse of the command.
if (askedForHelp) process.exitCode = 0;
