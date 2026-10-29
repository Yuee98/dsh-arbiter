/**
 * The run commands' argument parsing.
 *
 * Kept apart from the dataset commands because the two command families take different
 * shapes: a dataset command takes a dataset directory and a document path, while a run
 * command takes a frozen plan and an optional run directory. Merging them into one
 * parser would make every dataset command's flags valid on a run, which is how an
 * option gets silently ignored — the very thing these parsers exist to prevent.
 *
 * Every option is explicit and an unknown one is refused. `--dry-run` is accepted only
 * where it means something, and `--resume` only on `run`, so a command cannot be given
 * a flag it would not honour.
 */

import { RUN_FILES } from '../run/artifact.js';

/** Where one run command reads from and whether it may write. */
export interface RunCommandLine {
  readonly name: 'plan' | 'run' | 'resume' | 'show';
  /** The plan document, for the commands that read one. */
  readonly plan: string | null;
  /** The run directory, when the caller named one. */
  readonly dir: string | null;
  /** Continue an existing run instead of starting a new one. */
  readonly resume: boolean;
  /** Report what would happen without dispatching anything. */
  readonly dryRun: boolean;
}

/** Whether an argument names a run command. */
export function isRunCommand(name: string): name is RunCommandLine['name'] {
  return (
    name === 'plan' || name === 'run' || name === 'resume' || name === 'show'
  );
}

/** The usage text for the run commands, printed beside the offline ones. */
export const RUN_USAGE = [
  'run commands (explicit invocation only; none of them runs during verify or CI):',
  '  plan <plan.json>                       expand a frozen plan and report every cell',
  '  run <plan.json> [--dir DIR] [--resume] [--dry-run]',
  '                                         dispatch the plan; --dry-run only reports',
  '  resume <plan.json> [--dir DIR]         report which cells a continuation would run',
  '  show <run-dir>                         read a finished run and print its cells',
].join('\n');

/** The flags one run command accepts. */
interface RunFlags {
  readonly dir: string | null;
  readonly resume: boolean;
  readonly dryRun: boolean;
}

/** Read the run commands' flags; an unknown or misplaced one is refused. */
function readRunFlags(
  name: RunCommandLine['name'],
  rest: readonly string[],
): RunFlags | string {
  const flags = { dir: null, resume: false, dryRun: false } as {
    dir: string | null;
    resume: boolean;
    dryRun: boolean;
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--dir') {
      const value = rest[index + 1];
      if (value === undefined) return '--dir needs a value';
      index += 1;
      flags.dir = value;
    } else if (flag === '--resume' && name === 'run') {
      flags.resume = true;
    } else if (flag === '--dry-run' && name === 'run') {
      flags.dryRun = true;
    } else if (flag === '--resume' || flag === '--dry-run') {
      // A flag a command would not honour is refused rather than ignored: silently
      // accepting it is how someone believes a dry run wrote nothing when it did not.
      return `${name} does not take ${flag}`;
    } else {
      return `unknown option ${String(flag)}`;
    }
  }
  return flags;
}

/**
 * Parse one run command.
 *
 * `plan` and `resume` read a plan document, so they require one. `show` reads a run
 * directory, so it requires that instead. `run` requires a plan and derives the
 * directory from it when the caller does not name one, which is why the derived path is
 * a pure function of the plan rather than a timestamp.
 */
export function parseRunCommand(
  name: RunCommandLine['name'],
  rest: readonly string[],
): RunCommandLine | string {
  const [target, ...flags] = rest;
  if (target === undefined) {
    return name === 'show'
      ? `show needs a run directory\n\n${RUN_USAGE}`
      : `${name} needs a plan document\n\n${RUN_USAGE}`;
  }
  const parsed = readRunFlags(name, flags);
  if (typeof parsed === 'string') return `${parsed}\n\n${RUN_USAGE}`;
  if (name === 'show') {
    if (parsed.dir !== null)
      return `show takes the run directory as its argument`;
    return {
      name,
      plan: null,
      dir: target,
      resume: false,
      dryRun: false,
    };
  }
  return {
    name,
    plan: target,
    // The directory stays null when the caller names none: its default depends on the
    // dataset id inside the plan, so deriving it here would need the document read at
    // parse time. The command derives it once the plan is loaded.
    dir: parsed.dir,
    resume: parsed.resume || name === 'resume',
    dryRun: parsed.dryRun,
  };
}

/** Where one run's index lives, for a caller that reads it directly. */
export function indexOf(directory: string): string {
  return `${directory}/${RUN_FILES.index}`;
}
