/**
 * The evals command line.
 *
 * The first import is the loader hook, and every other module is loaded after it so
 * that imports of the shared review contract resolve from source. See
 * `cli/register.ts` for why that is needed at all.
 *
 * The data commands make no network call and no model call: they read and write
 * committed JSON. `run` is the one command that can dispatch, and only when someone
 * types it.
 *
 * An interrupt has to reach the runner, or the first Ctrl-C would leave the operator
 * waiting for work they already asked to stop. The signal is held here and handed to the
 * command, which stops dispatch and records the cells it never started instead of
 * abandoning a directory that claims to be running.
 */

import './cli/register.ts';

const { runCli } = await import('./cli/run.js');

const argv = process.argv.slice(2);
const askedForHelp =
  argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help';

const lifetime = new AbortController();
/**
 * Stop dispatch on the first interrupt, and keep the process alive long enough to write
 * the records the run already paid for. A second interrupt is the operator saying they do
 * not want to wait, so it exits immediately.
 */
const onInterrupt = (): void => {
  if (lifetime.signal.aborted) {
    process.stderr.write(
      'interrupted twice; exiting without finishing the record\n',
    );
    process.exit(130);
  }
  process.stderr.write('interrupt received; finishing the cells in flight\n');
  lifetime.abort();
};
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);

process.exitCode = await runCli(argv, {
  root: new URL('../../', import.meta.url).pathname,
  out: (line: string) => process.stdout.write(`${line}\n`),
  err: (line: string) => process.stderr.write(`${line}\n`),
  signal: lifetime.signal,
});
// Help is a successful request for information, not a misuse of the command.
if (askedForHelp) process.exitCode = 0;
