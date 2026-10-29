/**
 * The experiment commands' argument parsing.
 *
 * Kept apart from the dataset and run parsers for the same reason those two are apart:
 * each command family accepts a different argument, and merging them would make one
 * family's flag valid on another. Every option here is explicit and an unknown one is
 * refused.
 *
 * Two properties matter for this family:
 *
 *   - `plan` takes no `--write` and no `--out`. It is the dry run, and a flag that would
 *     write from it is exactly the mistake this parser exists to prevent.
 *   - `record` requires `--out`, because it writes: a command that writes a frozen
 *     artifact must be told where, rather than guessing a path.
 */

import { RECORD_FILE } from './commands.js';

/** Where one experiment command reads from and whether it may write. */
export interface ExperimentCommandLine {
  readonly name: 'check-all' | 'plan' | 'record';
  /** The definition document, for the commands that read one. */
  readonly definition: string | null;
  /** Where `record` writes. Null for every command that does not write. */
  readonly out: string | null;
}

/** Whether an argument names an experiment command. */
export function isExperimentCommand(
  name: string,
): name is ExperimentCommandLine['name'] {
  return name === 'check-all' || name === 'plan' || name === 'record';
}

/** The usage text for the experiment commands, printed beside the others. */
export const EXPERIMENT_USAGE = [
  'experiment commands (offline only; none of them calls a model):',
  '  experiments check-all                  validate and measure every committed experiment',
  '  experiments plan <definition.json>     expand the matrix and report the measured cells',
  '  experiments record <definition.json> [--out FILE]',
  '                                         write the frozen experiment record',
  `                                         (default ${RECORD_FILE})`,
].join('\n');

/** Read one experiment command's flags; an unknown or misplaced one is refused. */
export function parseExperimentCommand(
  name: ExperimentCommandLine['name'],
  rest: readonly string[],
): ExperimentCommandLine | string {
  const [target, ...flags] = rest;
  if (name === 'check-all') {
    if (target !== undefined) return 'experiments check-all takes no argument';
    return { name, definition: null, out: null };
  }
  if (target === undefined) {
    return `experiments ${name} needs a definition document\n\n${EXPERIMENT_USAGE}`;
  }
  let out: string | null = null;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--out' && name === 'record') {
      const value = flags[index + 1];
      if (value === undefined) return '--out needs a value';
      index += 1;
      out = value;
      continue;
    }
    // A flag this command would not honour is refused rather than ignored: silently
    // accepting `--out` on `plan` is how someone believes a dry run wrote a record.
    return name === 'record'
      ? `unknown option ${String(flag)}`
      : `experiments ${name} does not take ${String(flag)}`;
  }
  return {
    name,
    definition: target,
    out: out ?? (name === 'record' ? RECORD_FILE : null),
  };
}
