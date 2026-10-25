/** Observed effects derived from the conservative parse, without executing it. */
import type { DerivedFacts } from '../types.js';
import {
  CREDENTIAL_HINTS,
  INTERPRETERS,
  NETWORK_COMMANDS,
} from './constants.js';
import { hasUnresolved, normalizePath, resolvePath } from './paths.js';
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

interface WriteTarget {
  readonly target: string;
  readonly cwd: string | null;
}

function directWriteTargets(command: ShellCommand): WriteTarget[] {
  const name = command.argv[0] ?? '';
  const args = command.argv.slice(1);
  const targets: WriteTarget[] = [];
  if (['touch', 'mkdir', 'tee', 'truncate'].includes(name)) {
    for (const target of args.filter((arg) => !arg.startsWith('-'))) {
      targets.push({ target, cwd: command.cwd });
    }
  }
  if (['cp', 'mv', 'install', 'rsync', 'dd'].includes(name)) {
    const last = args.at(-1);
    if (last !== undefined) targets.push({ target: last, cwd: command.cwd });
  }
  if (['rm', 'shred', 'unlink', 'rmdir'].includes(name)) {
    for (const argument of args) {
      if (!argument.startsWith('-'))
        targets.push({ target: argument, cwd: command.cwd });
    }
  }
  if (name === 'find' && args.includes('-delete')) {
    const first = args[0];
    if (first !== undefined) targets.push({ target: first, cwd: command.cwd });
  }
  return targets;
}

class FactCollector {
  readonly writes: string[] = [];
  readonly networkCommands: string[] = [];
  readonly credentialPaths: string[] = [];
  readonly pipelineExec: string[][] = [];
  readonly writesOutsideWorkspace: string[] = [];
  expansionRisk: string | null = null;

  private readonly parse: ShellParse;
  private readonly options: FactsOptions;

  constructor(parse: ShellParse, options: FactsOptions) {
    this.parse = parse;
    this.options = options;
  }

  private networkEffects(command: ShellCommand): void {
    const name = command.argv[0] ?? '';
    const args = command.argv.slice(1);
    if (
      NETWORK_COMMANDS.has(name) ||
      (name === 'git' && args[0] === 'push') ||
      name === 'gh'
    ) {
      this.networkCommands.push(name);
    }
    if (name !== 'curl' && name !== 'wget') return;
    const shellPipe = args.find((argument) =>
      ['sh', 'bash', 'zsh'].includes(argument),
    );
    const next = this.parse.commands.find(
      (other) => other.index === command.index + 1,
    );
    const pipedInterpreter =
      next !== undefined && INTERPRETERS.has(next.argv[0] ?? '')
        ? next.argv[0]
        : undefined;
    if (shellPipe !== undefined || pipedInterpreter !== undefined) {
      this.pipelineExec.push([name, shellPipe ?? pipedInterpreter ?? 'sh']);
    }
  }

  private writeTarget({ target, cwd }: WriteTarget): void {
    if (target === '' || target.startsWith('-')) return;
    if (hasUnresolved(target)) {
      this.expansionRisk = 'write target contains an unresolved expansion';
      this.writes.push(target);
      return;
    }
    let resolved: string;
    if (target.startsWith('/')) {
      resolved = normalizePath(target);
    } else {
      if (cwd === null) {
        this.expansionRisk = 'working directory is not statically known';
        this.writes.push(target);
        return;
      }
      resolved = resolvePath(target, cwd);
    }
    this.writes.push(resolved);
    if (this.options.workspaceRoot !== null) {
      const root = normalizePath(this.options.workspaceRoot);
      const inside = resolved === root || resolved.startsWith(`${root}/`);
      if (!inside) this.writesOutsideWorkspace.push(resolved);
    }
  }

  private commandEffects(command: ShellCommand): void {
    const name = command.argv[0] ?? '';
    const args = command.argv.slice(1);
    this.networkEffects(command);
    for (const argument of [name, ...args]) {
      if (
        CREDENTIAL_HINTS.some((hint) => argument.toLowerCase().includes(hint))
      ) {
        this.credentialPaths.push(argument);
      }
    }
    const writeTargets = directWriteTargets(command);
    for (const redirect of command.redirects) {
      if (redirect.op.includes('>'))
        writeTargets.push({ target: redirect.target, cwd: redirect.cwd });
      if (hasUnresolved(redirect.target))
        this.expansionRisk = 'redirect target contains an unresolved expansion';
    }
    for (const target of writeTargets) this.writeTarget(target);
    for (const arg of args) {
      if (
        hasUnresolved(arg) &&
        ['rm', 'mv', 'dd', 'shred', 'find'].includes(name)
      ) {
        this.expansionRisk =
          'destructive argument contains an unresolved expansion';
      }
    }
  }

  collect(): void {
    for (const command of this.parse.commands) this.commandEffects(command);
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

/** Build only the observed facts section, retaining parse incompleteness. */
export function buildFacts(
  parse: ShellParse,
  options: FactsOptions,
): FactsResult {
  if (parse.status === 'error') return parseErrorFacts(options);
  const collected = new FactCollector(parse, options);
  collected.collect();
  const observedWrites = [...new Set(collected.writes)];
  return {
    facts: {
      version: 1,
      parse: { status: 'ok', statements: parse.statements },
      observed: {
        writes: observedWrites.slice(0, 30),
        networkCommands: [...new Set(collected.networkCommands)].slice(0, 30),
        credentialPaths: [...new Set(collected.credentialPaths)].slice(0, 30),
        pipelineExec: collected.pipelineExec.slice(0, 10),
        substitutions: parse.substitutions,
        subshells: parse.subshells,
      },
      opaque: parse.opaque,
      opaqueReason: parse.opaqueReasons[0] ?? null,
      unresolvedExpansions: parse.unresolved.slice(0, 30),
      expansionRisk: collected.expansionRisk,
      completeness: parse.completeness,
      parentAuthorizationPresent: options.parentAuthorizationPresent,
      overlapsDeniedEffect: options.overlapsDeniedEffect,
      historyTruncated: options.historyTruncated,
      ...(observedWrites.length > 30 ? { truncated: true } : {}),
    },
    writesOutsideWorkspace: collected.writesOutsideWorkspace,
  };
}
