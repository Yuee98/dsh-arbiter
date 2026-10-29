/**
 * Scoped reset of this plugin's old test data.
 *
 *   node scripts/arbiter-reset-test-data.ts --home ~/.dsh
 *   node scripts/arbiter-reset-test-data.ts --home ~/.dsh --apply <planId>
 *
 * The default is a dry run. Without `--apply <planId>` nothing on disk is
 * touched: the tool reads the plugin's data directory and prints every file it
 * would remove, with the reason, the row counts, and the profiles and projects
 * those rows belong to.
 *
 * A real run needs both switches, and the digest it passes must be the one the
 * preview printed for the same directory. Anything that changed in between is
 * refused rather than deleted.
 *
 * This is a **single, explicit operation**, not a startup task. It is not wired
 * into the plugin, an install hook or CI: the plugin never deletes old data on
 * its own, and the reset only runs when an operator asks for it.
 *
 * Exit codes: 0 for a clean preview or a completed run, 1 when the run was
 * refused or stopped, 2 for a usage error.
 */
import console from 'node:console';
import process from 'node:process';

import { join } from 'node:path';

import { applyPlan } from './arbiter-reset/apply.ts';
import { buildPlan } from './arbiter-reset/plan.ts';
import { renderOutcome, renderPlan } from './arbiter-reset/report.ts';
import { scanSessionLogs } from './arbiter-reset/session-logs.ts';
import type { SessionLogFinding } from './arbiter-reset/session-logs.ts';

/** How the operator invoked the tool. */
export interface Options {
  readonly home: string;
  /** The plan digest to apply; absent means a dry run. */
  readonly apply: string | null;
  /** Profiles the reset is authorized for. */
  readonly profiles: readonly string[] | null;
  /** Whether rows in the current record format may go with the old database. */
  readonly includeCurrentFormatRecords: boolean;
  /** Whether to scan host session logs for this plugin's records. */
  readonly scanLogs: boolean;
}

/** The usage text, so a wrong invocation explains itself. */
const USAGE = `usage:
  arbiter-reset-test-data.ts --home <dsh-data-dir> [--profiles a,b] [--scan-logs]
  arbiter-reset-test-data.ts --home <dsh-data-dir> --apply <planId> [--profiles a,b] [--include-current-format-records]

Without --apply nothing is deleted. --home is the DSH data directory (the one
that contains arbiter/), not a profile directory.`;

/** Read one option's value, refusing a flag that has none. */
function valueOf(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`${name} needs a value\n${USAGE}`);
  return value;
}

/** Reject anything that is not a flag this tool defines. */
function rejectUnknown(
  known: readonly string[],
  args: readonly string[],
): void {
  const valueFlags = new Set(['--home', '--apply', '--profiles']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (known.includes(arg)) {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    // A bare value is only valid directly after a value flag.
    const previous = args[index - 1] ?? '';
    if (valueFlags.has(previous)) continue;
    throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
}

/** Parse the command line. Throws a usage message rather than guessing. */
export function parseArgs(args: readonly string[]): Options {
  const known = [
    '--home',
    '--apply',
    '--profiles',
    '--include-current-format-records',
    '--scan-logs',
  ];
  rejectUnknown(known, args);
  const home = valueOf(args, '--home');
  if (home === null) throw new Error(`--home is required\n${USAGE}`);
  const profiles = valueOf(args, '--profiles');
  return {
    home,
    apply: valueOf(args, '--apply'),
    profiles:
      profiles === null
        ? null
        : profiles
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ''),
    includeCurrentFormatRecords: args.includes(
      '--include-current-format-records',
    ),
    scanLogs: args.includes('--scan-logs'),
  };
}

/** Every session log under one data directory, or none when scanning is off. */
function readLogs(options: Options): readonly SessionLogFinding[] {
  if (!options.scanLogs) return [];
  return scanSessionLogs(join(options.home, 'sessions'));
}

/**
 * Run one invocation; returns the process exit code.
 *
 * Synchronous on purpose: the tool only reads files and deletes what the plan
 * already classified, so an await boundary would add nothing but a way for two
 * invocations to interleave.
 */
export function main(
  args: readonly string[],
  write: (text: string) => void = (text) => {
    console.log(text);
  },
): number {
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const sessionLogs = readLogs(options);
  const plan = buildPlan(options.home, sessionLogs, {
    ...(options.profiles === null ? {} : { expectProfiles: options.profiles }),
    includeCurrentFormatRecords: options.includeCurrentFormatRecords,
  });
  if (options.apply === null) {
    write(renderPlan(plan));
    return plan.refusals.length === 0 ? 0 : 1;
  }
  const outcome = applyPlan(plan, options.apply);
  write(renderOutcome(plan, outcome));
  return outcome.applied ? 0 : 1;
}

if (process.argv[1]?.endsWith('arbiter-reset-test-data.ts') === true) {
  process.exitCode = main(process.argv.slice(2));
}
