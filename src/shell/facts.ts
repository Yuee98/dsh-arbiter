/**
 * Observed effects derived from the parse, without executing anything.
 *
 * This layer answers "what did the parse actually see?" and nothing else. It
 * never infers the absence of an effect from a missing node, and its
 * `completeness` describes fact extraction only — structure and per-word values
 * are separate dimensions and are reported by `parse.ts`.
 *
 * Words are classified by the adapter, not by looking for `$` in the text: a
 * statically known `'$X'` is a literal dollar, while a dynamic `$X` is an unknown
 * value. A path built from an unknown value is reported in its original form and
 * never resolved to a guessed location.
 */

import type { DerivedFacts } from '../types.js';
import {
  CREDENTIAL_HINTS,
  INTERPRETERS,
  NETWORK_COMMANDS,
} from './constants.js';
import { normalizePath, resolvePath } from './paths.js';
import { isPlainPathValue } from './quote.js';
import type { ShellCommand, ShellParse } from './types.js';

export interface FactsOptions {
  readonly cwd: string;
  readonly workspaceRoot: string | null;
  readonly parentAuthorizationPresent: boolean | null;
  readonly historyTruncated: boolean;
  readonly overlapsDeniedEffect: boolean;
}

export interface FactsResult {
  readonly facts: DerivedFacts;
  readonly writesOutsideWorkspace: readonly string[];
}

/** Most entries any one observed list may carry before it is truncated. */
const LIST_LIMIT = 30;

/** Pipeline-exec entries are the most specific observation, so they cap lower. */
const PIPELINE_LIMIT = 10;

/**
 * One candidate write target.
 *
 * `target` is always the *decoded value* of a static word, never the canonical
 * matching text: `touch "/tmp/a b"` matches as `touch '/tmp/a b'`, but the path it
 * writes is `/tmp/a b`. A non-static or unusable value is reported in its original
 * form and is never resolved to a guessed location.
 */
interface WriteTarget {
  readonly target: string;
  readonly dynamic: boolean;
  readonly cwd: string | null;
}

/**
 * A write target from one argv position.
 *
 * Both the flag and the text come from the same word, so a decoded path is never
 * paired with a canonical (quoted) text or the other way round.
 */
function writeTargetAt(
  command: ShellCommand,
  index: number,
): WriteTarget | null {
  const word = command.words[index];
  if (word === undefined) return null;
  if (word.status !== 'static') {
    return { target: word.text, dynamic: true, cwd: command.cwd };
  }
  const value = word.value ?? '';
  return {
    target: value,
    dynamic: !isPlainPathValue(value),
    cwd: command.cwd,
  };
}

/**
 * Whether this command's stdout still reaches the pipe it writes to.
 *
 * A redirect on stdout — the default descriptor for an output operator — sends the
 * bytes to a file instead, and a duplication `1>&2` moves stdout onto stderr. A
 * duplication `2>&1` moves stderr *onto* stdout and leaves stdout on the pipe.
 */
function pipeReceivesStdout(command: ShellCommand): boolean {
  for (const redirect of command.redirects) {
    if (!redirect.op.includes('>')) continue;
    if (redirect.descriptor !== null && redirect.descriptor !== 1) continue;
    if (redirect.kind === 'file') return false;
    // `1>&2`, `1>&-` and `>&2` take stdout away from the pipe too.
    return false;
  }
  return true;
}

/**
 * Whether the receiving command still reads its stdin from the pipe.
 *
 * `curl … | sh < script` builds the pipe, but `sh` reads the file instead of the
 * download. A here-string or here-doc on stdin replaces it the same way.
 */
function pipeFeedsStdin(command: ShellCommand): boolean {
  for (const redirect of command.redirects) {
    if (redirect.op.startsWith('<<')) return false;
    // An input redirect on the default descriptor (stdin) or on 0 replaces it.
    if (redirect.op.includes('<') && !redirect.op.includes('>')) return false;
    if (redirect.descriptor === 0) return false;
  }
  return true;
}

/** Commands whose non-option arguments are all written to. */
const ALL_ARGS_WRITTEN = new Set(['touch', 'mkdir', 'tee', 'truncate']);
/** Commands whose last argument is the destination (plus `rm`, handled below). */
const LAST_ARG_WRITTEN = new Set(['cp', 'mv', 'install', 'rsync', 'dd']);
const REMOVING = new Set(['rm', 'shred', 'unlink', 'rmdir']);

/** Add the target at `index` when that word is a real argument. */
function addWriteTarget(
  command: ShellCommand,
  index: number,
  targets: WriteTarget[],
): void {
  const target = writeTargetAt(command, index);
  if (target !== null) targets.push(target);
}

function directWriteTargets(command: ShellCommand): WriteTarget[] {
  const name = command.words[0]?.value ?? '';
  const targets: WriteTarget[] = [];
  const args = command.words.slice(1);
  if (ALL_ARGS_WRITTEN.has(name) || REMOVING.has(name)) {
    for (const [offset, word] of args.entries()) {
      if (!(word.value ?? '').startsWith('-')) {
        addWriteTarget(command, offset + 1, targets);
      }
    }
    return targets;
  }
  if (LAST_ARG_WRITTEN.has(name)) {
    if (args.length > 0)
      addWriteTarget(command, command.words.length - 1, targets);
    return targets;
  }
  if (
    name === 'find' &&
    args.length > 0 &&
    args.some((word) => word.value === '-delete')
  ) {
    addWriteTarget(command, 1, targets);
  }
  return targets;
}

function isNetworkCommand(name: string, args: readonly string[]): boolean {
  if (NETWORK_COMMANDS.has(name) || name === 'gh') return true;
  return name === 'git' && args[0] === 'push';
}

class FactCollector {
  readonly writes: string[] = [];
  readonly networkCommands: string[] = [];
  readonly credentialPaths: string[] = [];
  readonly pipelineExec: string[][] = [];
  readonly writesOutsideWorkspace: string[] = [];
  expansionRisk: string | null = null;
  wordGap = false;
  truncated = false;

  private readonly parse: ShellParse;
  private readonly options: FactsOptions;

  constructor(parse: ShellParse, options: FactsOptions) {
    this.parse = parse;
    this.options = options;
  }

  private networkEffects(command: ShellCommand): void {
    const name = command.words[0]?.value ?? '';
    const args = command.words.slice(1).map((word) => word.value ?? word.text);
    if (isNetworkCommand(name, args)) this.networkCommands.push(name);
    if (name !== 'curl' && name !== 'wget') return;
    const interpreter = this.pipedInterpreter(command);
    if (interpreter !== null) this.pipelineExec.push([name, interpreter]);
  }

  /**
   * The interpreter a downloader's output is piped into.
   *
   * Only a real pipe edge in the AST counts. Two commands on separate lines run
   * sequentially, so reporting `curl\nbash` as `curl | bash` would invent a
   * dangerous fact nobody observed.
   */
  private pipedInterpreter(command: ShellCommand): string | null {
    // Only a real pipe edge proves the download is executed. A bare `sh` argument
    // (`curl --output sh …`) is a value, not a pipe.
    if (command.pipeTarget === null) return null;
    // The edge also has to carry this command's stdout. `curl … > out.txt | sh`
    // creates a pipe, but the redirect takes stdout away from it, so nothing
    // downloaded reaches `sh`.
    if (!pipeReceivesStdout(command)) return null;
    const receiver = this.parse.commands.find(
      (other) => other.index === command.pipeTarget,
    );
    if (receiver === undefined) return null;
    if (!pipeFeedsStdin(receiver)) return null;
    const name = receiver.words[0]?.value ?? '';
    return INTERPRETERS.has(name) ? name : null;
  }

  private writeTarget({ target, dynamic, cwd }: WriteTarget): void {
    if (target === '' || target.startsWith('-')) return;
    // A dynamic path keeps its original expression: the shell may expand it to
    // anything, so neither a resolved location nor "no writes" is claimed.
    if (dynamic) {
      this.expansionRisk = 'write target contains an unresolved expansion';
      this.writes.push(target);
      return;
    }
    // An absolute path does not depend on the working directory, so an unknown
    // directory only stops relative targets from being classified.
    if (!target.startsWith('/') && cwd === null) {
      this.expansionRisk = 'working directory is not statically known';
      this.writes.push(target);
      return;
    }
    const resolved =
      cwd === null ? normalizePath(target) : resolvePath(target, cwd);
    this.writes.push(resolved);
    const root = this.options.workspaceRoot;
    if (root === null) return;
    const inside =
      resolved === normalizePath(root) ||
      resolved.startsWith(`${normalizePath(root)}/`);
    if (!inside) this.writesOutsideWorkspace.push(resolved);
  }

  private commandEffects(command: ShellCommand): void {
    const name = command.words[0]?.value ?? '';
    const args = command.words.slice(1).map((word) => word.value ?? word.text);
    this.networkEffects(command);
    for (const argument of [name, ...args]) {
      if (
        CREDENTIAL_HINTS.some((hint) => argument.toLowerCase().includes(hint))
      ) {
        this.credentialPaths.push(argument);
      }
    }
    for (const target of directWriteTargets(command)) this.writeTarget(target);
    if (['rm', 'mv', 'dd', 'shred', 'find'].includes(name)) {
      const dynamic = command.words
        .slice(1)
        .some((word) => word.status === 'dynamic');
      if (dynamic) {
        this.expansionRisk =
          'destructive argument contains an unresolved expansion';
      }
    }
  }

  /**
   * File redirects, wherever they appeared.
   *
   * A redirect can belong to a command, to a compound construct, or to nothing at
   * all (`> out`); reading them from the global list means none of those writes is
   * missed. Descriptor duplication, heredocs and here-strings were already excluded
   * from that list.
   */
  private redirectEffects(): void {
    for (const redirect of this.parse.redirects) {
      if (!redirect.op.includes('>')) continue;
      this.writeTarget({
        target: redirect.target,
        // A repeated body or an unknown directory means a relative target may
        // resolve elsewhere on a later pass, so it is not a single known path.
        dynamic: redirect.dynamic || redirect.unresolved,
        cwd: redirect.cwd,
      });
    }
  }

  collect(): void {
    for (const command of this.parse.commands) this.commandEffects(command);
    this.redirectEffects();
    for (const word of this.parse.words) {
      if (word.status === 'dynamic') this.wordGap = true;
    }
    // Every capped category downgrades fact completeness; only `writes` has a
    // separate `truncated` flag in the shared shape, so the others are reported
    // through `completeness` rather than silently looking complete.
    // Any capped list that overflowed makes the observation set incomplete, and
    // `truncated` says so explicitly rather than only lowering completeness.
    if (
      this.writes.length > LIST_LIMIT ||
      new Set(this.networkCommands).size > LIST_LIMIT ||
      new Set(this.credentialPaths).size > LIST_LIMIT ||
      this.parse.unresolved.length > LIST_LIMIT ||
      this.pipelineExec.length > PIPELINE_LIMIT
    ) {
      this.truncated = true;
    }
  }
}

function parseErrorFacts(options: FactsOptions): FactsResult {
  return {
    facts: {
      version: 1,
      parse: { status: 'error', statements: 0 },
      observed: {
        writes: [],
        networkCommands: [],
        credentialPaths: [],
        pipelineExec: [],
        substitutions: 0,
        subshells: 0,
      },
      opaque: true,
      opaqueReason: 'parse error',
      unresolvedExpansions: [],
      expansionRisk: null,
      completeness: 'none',
      parentAuthorizationPresent: options.parentAuthorizationPresent,
      overlapsDeniedEffect: options.overlapsDeniedEffect,
      historyTruncated: options.historyTruncated,
    },
    writesOutsideWorkspace: [],
  };
}

/**
 * Fact completeness.
 *
 * This describes how much of the call's effect space was actually observed. It is
 * a separate dimension from structure and from per-word values, but it can never be
 * higher than the structure allows: effects inside a fragment nobody parsed were
 * not observed either.
 *
 *  - `none` when the parse could not be used at all;
 *  - `partial` when the structure is incomplete, the call is opaque (interpreter,
 *    script, self-evaluating builtin), it carries dynamic words or expansions, or
 *    an observation list hit its limit;
 *  - `complete` when every word and observed list was fully read.
 *
 * A `complete` fact section still never asserts that an effect is absent.
 */
function factCompleteness(
  parse: ShellParse,
  collected: FactCollector,
): 'complete' | 'partial' | 'none' {
  if (parse.status === 'error') return 'none';
  if (parse.completeness !== 'complete') return 'partial';
  if (parse.opaque) return 'partial';
  if (parse.unresolved.length > 0) return 'partial';
  if (collected.wordGap) return 'partial';
  if (collected.truncated) return 'partial';
  return 'complete';
}

/** Build only the observed facts section, retaining parse incompleteness. */
export function buildFacts(
  parse: ShellParse,
  options: FactsOptions,
): FactsResult {
  if (parse.status === 'error') return parseErrorFacts(options);
  const collected = new FactCollector(parse, options);
  collected.collect();
  const observedWrites = [...new Set(collected.writes)];
  const completeness = factCompleteness(parse, collected);
  return {
    facts: {
      version: 1,
      parse: { status: 'ok', statements: parse.statements },
      observed: {
        writes: observedWrites.slice(0, LIST_LIMIT),
        networkCommands: [...new Set(collected.networkCommands)].slice(
          0,
          LIST_LIMIT,
        ),
        credentialPaths: [...new Set(collected.credentialPaths)].slice(
          0,
          LIST_LIMIT,
        ),
        pipelineExec: collected.pipelineExec.slice(0, PIPELINE_LIMIT),
        substitutions: parse.substitutions,
        subshells: parse.subshells,
      },
      opaque: parse.opaque,
      opaqueReason: parse.opaqueReasons[0] ?? null,
      unresolvedExpansions: parse.unresolved.slice(0, LIST_LIMIT),
      expansionRisk: collected.expansionRisk,
      completeness,
      parentAuthorizationPresent: options.parentAuthorizationPresent,
      overlapsDeniedEffect: options.overlapsDeniedEffect,
      historyTruncated: options.historyTruncated,
      // One flag covers every capped category: the reviewer only needs to know
      // that some observation was cut, and `completeness` already says the set is
      // not exhaustive.
      ...(collected.truncated ? { truncated: true } : {}),
    },
    writesOutsideWorkspace: collected.writesOutsideWorkspace,
  };
}
