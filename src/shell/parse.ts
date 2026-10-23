/**
 * A conservative shell reader for policy matching.
 *
 * dsh-arbiter needs the structure of a bash command — statements, pipelines,
 * redirects, assignments, subshells and expansions — not a full POSIX shell.
 * This reader keeps the security-relevant distinctions and records exactly how
 * complete its view is. It never claims that an unseen effect is absent:
 * interpreters, command substitutions, subshells, heredocs, and unresolved
 * expansions downgrade `completeness`, and policy never uses an incomplete
 * parse to grant `allow`.
 *
 * This is a deliberate first-version implementation choice instead of loading
 * tree-sitter-bash WASM inside the synchronous pre-execute path. The parser is
 * small, dependency-free and browser-safe, so the host gate and the rule tester
 * in the configuration page share one implementation. It is *not* a shell and
 * does not execute anything.
 */

import type { DerivedFacts } from '../types.js';

export type ShellCompleteness = 'complete' | 'partial' | 'none';

export interface ShellRedirect {
  readonly index: number;
  readonly op: string;
  readonly target: string;
  readonly raw: string;
  readonly commandIndex: number;
  readonly unresolved: boolean;
  /** Effective working directory for this redirect, or null when unknown. */
  readonly cwd: string | null;
}

export interface ShellAssignment {
  readonly index: number;
  readonly name: string;
  readonly value: string;
  readonly raw: string;
  readonly commandIndex: number;
}

export interface ShellCommand {
  readonly index: number;
  /** Normalized command words; unresolved expansions remain as `$NAME`. */
  readonly argv: readonly string[];
  readonly raw: string;
  readonly assignments: readonly ShellAssignment[];
  readonly redirects: readonly ShellRedirect[];
  readonly incomplete: boolean;
  readonly pipelineIndex: number;
  /** Effective working directory when this command runs, or null when unknown. */
  readonly cwd: string | null;
}

export interface ShellParse {
  readonly status: 'ok' | 'error';
  readonly statements: number;
  readonly commands: readonly ShellCommand[];
  readonly redirects: readonly ShellRedirect[];
  readonly assignments: readonly ShellAssignment[];
  readonly subshells: number;
  readonly substitutions: number;
  readonly heredocs: number;
  readonly unresolved: readonly string[];
  readonly opaque: boolean;
  readonly opaqueReasons: readonly string[];
  readonly completeness: ShellCompleteness;
  readonly background: boolean;
  readonly nodes: readonly string[];
  readonly argv: readonly string[];
  readonly comments: readonly string[];
  readonly error?: string;
}

interface WordToken {
  readonly kind: 'word';
  readonly value: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly unresolved: readonly string[];
  readonly substitutions: number;
  readonly quoted: boolean;
}

interface OperatorToken {
  readonly kind: 'op';
  readonly value: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly unresolved: readonly string[];
  readonly substitutions: number;
}

interface RedirectToken {
  readonly kind: 'redirect';
  readonly value: string;
  readonly fd: string | null;
  readonly target: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly unresolved: readonly string[];
}

type Token = WordToken | OperatorToken | RedirectToken;

const REDIRECT_OPERATORS = [
  '<<<',
  '<<-',
  '&>>',
  '>>',
  '<<',
  '>&',
  '<&',
  '<>',
  '>|',
  '&>',
  '>',
  '<',
] as const;

const CONTROL_OPERATORS = [
  '&&',
  '||',
  '|&',
  ';;',
  ';',
  '|',
  '&',
  '(',
  ')',
  '{',
  '}',
] as const;

const RESERVED_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'coproc',
  'time',
  '!',
]);

const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'powershell',
  'pwsh',
]);

const SCRIPT_SUFFIXES = [
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.php',
  '.lua',
  '.ps1',
] as const;

const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'telnet',
  'http',
  'https',
  'xh',
  'aria2c',
]);

const CREDENTIAL_HINTS = [
  '.env',
  '.ssh/',
  'id_rsa',
  'id_ed25519',
  '.aws/credentials',
  '.netrc',
  'credentials.json',
  '.pem',
  'token',
  'secret',
  'password',
];

function makeParse(
  fields: Omit<ShellParse, 'nodes' | 'argv'> & {
    readonly nodes?: readonly string[];
  },
): ShellParse {
  return {
    ...fields,
    nodes: fields.nodes ?? [],
    argv: fields.commands[0]?.argv ?? [],
  };
}

function readWord(
  source: string,
  start: number,
): {
  value: string;
  raw: string;
  end: number;
  unresolved: string[];
  substitutions: number;
  quoted: boolean;
} {
  let index = start;
  let value = '';
  let quoted = false;
  const unresolved: string[] = [];
  let substitutions = 0;

  const readDollar = (): void => {
    const dollar = index;
    index += 1;
    if (source[index] === '(') {
      // Command substitution. Consume a balanced body without evaluating it.
      let depth = 1;
      index += 1;
      const bodyStart = index;
      while (index < source.length && depth > 0) {
        const char = source[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        index += 1;
      }
      const body = source.slice(bodyStart, Math.max(bodyStart, index - 1));
      value += `$(${body})`;
      unresolved.push(`$(${body})`);
      substitutions += 1;
      return;
    }
    if (source[index] === '{') {
      let depth = 1;
      index += 1;
      const bodyStart = index;
      while (index < source.length && depth > 0) {
        const char = source[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        index += 1;
      }
      const body = source.slice(bodyStart, Math.max(bodyStart, index - 1));
      const expansion = `\${${body}}`;
      value += expansion;
      unresolved.push(expansion);
      return;
    }
    const nameStart = index;
    while (
      index < source.length &&
      /[A-Za-z0-9_@*#?$!-]/u.test(source[index] ?? '')
    ) {
      index += 1;
    }
    if (index === nameStart) {
      value += '$';
      return;
    }
    const expansion = source.slice(dollar, index);
    value += expansion;
    unresolved.push(expansion);
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === ' ' || char === '\t' || char === '\n') break;
    if (';&|(){}<>'.includes(char)) break;
    if (char === '\\') {
      const next = source[index + 1];
      if (next === '\n') {
        index += 2;
        continue;
      }
      value += next ?? '';
      index += next === undefined ? 1 : 2;
      quoted = true;
      continue;
    }
    if (char === "'") {
      quoted = true;
      index += 1;
      while (index < source.length && source[index] !== "'") {
        value += source[index] ?? '';
        index += 1;
      }
      if (source[index] === "'") index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      while (index < source.length && source[index] !== '"') {
        const inner = source[index] ?? '';
        if (inner === '\\') {
          const next = source[index + 1];
          if (next !== undefined && '"\\$`'.includes(next)) {
            value += next;
            index += 2;
            continue;
          }
          value += inner;
          index += 1;
          continue;
        }
        if (inner === '$') {
          readDollar();
          continue;
        }
        if (inner === '`') {
          const close = source.indexOf('`', index + 1);
          const end = close === -1 ? source.length : close;
          const body = source.slice(index + 1, end);
          value += `\`${body}\``;
          unresolved.push(`\`${body}\``);
          substitutions += 1;
          index = end + 1;
          continue;
        }
        value += inner;
        index += 1;
      }
      if (source[index] === '"') index += 1;
      continue;
    }
    if (char === '$') {
      readDollar();
      continue;
    }
    if (char === '`') {
      const close = source.indexOf('`', index + 1);
      const end = close === -1 ? source.length : close;
      const body = source.slice(index + 1, end);
      value += `\`${body}\``;
      unresolved.push(`\`${body}\``);
      substitutions += 1;
      index = end + 1;
      continue;
    }
    value += char;
    index += 1;
  }
  return {
    value,
    raw: source.slice(start, index),
    end: index,
    unresolved,
    substitutions,
    quoted,
  };
}

function tokenize(source: string): {
  tokens: Token[];
  heredocs: number;
  comments: string[];
} {
  const tokens: Token[] = [];
  const comments: string[] = [];
  let index = 0;
  let heredocs = 0;

  const previousEndsWithWhitespace = (): boolean => {
    if (index === 0) return true;
    return /[\s;&|(){}]/u.test(source[index - 1] ?? '');
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\\' && source[index + 1] === '\n') {
      index += 2;
      continue;
    }
    if (char === '\n') {
      tokens.push({
        kind: 'op',
        value: '\n',
        raw: '\n',
        start: index,
        end: index + 1,
        unresolved: [],
        substitutions: 0,
      });
      index += 1;
      continue;
    }
    if (char === '#' && previousEndsWithWhitespace()) {
      const end = source.indexOf('\n', index);
      comments.push(source.slice(index, end === -1 ? source.length : end));
      index = end === -1 ? source.length : end;
      continue;
    }

    // Optional file-descriptor prefix directly before a redirect: `2>`, `2>>`.
    let fd: string | null = null;
    let redirectStart = index;
    if (char >= '0' && char <= '9') {
      let digitEnd = index;
      for (;;) {
        const digit = source[digitEnd];
        if (digit === undefined || digit < '0' || digit > '9') break;
        digitEnd += 1;
      }
      const operator = REDIRECT_OPERATORS.find((candidate) =>
        source.startsWith(candidate, digitEnd),
      );
      if (operator !== undefined) {
        fd = source.slice(index, digitEnd);
        redirectStart = digitEnd;
      }
    }
    const redirect = REDIRECT_OPERATORS.find((candidate) =>
      source.startsWith(candidate, redirectStart),
    );
    if (redirect !== undefined) {
      let cursor = redirectStart + redirect.length;
      while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
      let target = '';
      const targetUnresolved: string[] = [];
      if (
        cursor < source.length &&
        !';&|(){}<>'.includes(source[cursor] ?? '')
      ) {
        const word = readWord(source, cursor);
        target = word.value;
        targetUnresolved.push(...word.unresolved);
        cursor = word.end;
      }
      if (redirect === '<<' || redirect === '<<-') heredocs += 1;
      tokens.push({
        kind: 'redirect',
        value: redirect,
        fd,
        target,
        raw: source.slice(index, cursor),
        start: index,
        end: cursor,
        unresolved: targetUnresolved,
      });
      index = cursor;
      continue;
    }

    const operator = CONTROL_OPERATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (operator !== undefined) {
      tokens.push({
        kind: 'op',
        value: operator,
        raw: operator,
        start: index,
        end: index + operator.length,
        unresolved: [],
        substitutions: 0,
      });
      index += operator.length;
      continue;
    }

    const word = readWord(source, index);
    if (word.end === index) {
      // Unknown byte; consume it so the reader always advances.
      tokens.push({
        kind: 'word',
        value: char,
        raw: char,
        start: index,
        end: index + 1,
        unresolved: [],
        substitutions: 0,
        quoted: false,
      });
      index += 1;
      continue;
    }
    tokens.push({
      kind: 'word',
      value: word.value,
      raw: word.raw,
      start: index,
      end: word.end,
      unresolved: word.unresolved,
      substitutions: word.substitutions,
      quoted: word.quoted,
    });
    index = word.end;
  }

  return { tokens, heredocs, comments };
}

/**
 * Parse one shell command line.
 *
 * Parsing failures return `status: "error"` and `completeness: "none"` rather
 * than throwing, so policy can record a rule-independent failure.
 */
export function parseShell(source: string, initialCwd?: string): ShellParse {
  try {
    const tokenized = tokenize(source);
    const tokens = tokenized.tokens;
    const commands: ShellCommand[] = [];
    const redirects: ShellRedirect[] = [];
    const assignments: ShellAssignment[] = [];
    const unresolved = new Set<string>();
    const opaqueReasons = new Set<string>();
    let substitutions = 0;
    let subshells = 0;
    let statements = 0;
    let background = false;
    let incomplete = false;
    let pipelineIndex = 0;
    let words: WordToken[] = [];
    let cmdRedirects: RedirectToken[] = [];
    let currentCwd: string | null = initialCwd ?? null;
    let cwdUncertain = initialCwd === undefined;
    const pipelineState = { seen: false, cd: false };

    const known: Record<string, string> = {};

    const flush = (): void => {
      if (words.length === 0 && cmdRedirects.length === 0) return;
      statements += 1;
      const commandIndex = commands.length;
      const commandAssignments: ShellAssignment[] = [];
      const argv: string[] = [];
      let index = 0;
      let assignmentPhase = true;
      for (const word of words) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(word.value);
        if (assignmentPhase && assignment !== null) {
          const name = assignment[1] ?? '';
          let value = assignment[2] ?? '';
          for (const [key, replacement] of Object.entries(known)) {
            value = value.split(`$${key}`).join(replacement);
          }
          known[name] = value;
          const node: ShellAssignment = {
            index,
            name,
            value,
            raw: word.raw,
            commandIndex,
          };
          commandAssignments.push(node);
          assignments.push(node);
          index += 1;
          continue;
        }
        assignmentPhase = false;
        let value = word.value;
        for (const [key, replacement] of Object.entries(known)) {
          value = value.split(`$${key}`).join(replacement);
        }
        for (const expansion of word.unresolved) {
          const name =
            expansion.startsWith('$') &&
            !expansion.startsWith('${') &&
            !expansion.startsWith('$(')
              ? expansion.slice(1)
              : '';
          if (name.length > 0 && Object.hasOwn(known, name)) continue;
          unresolved.add(expansion);
        }
        argv.push(value);
        index += 1;
      }
      const commandRedirects: ShellRedirect[] = [];
      for (const redirect of cmdRedirects) {
        const node: ShellRedirect = {
          index,
          op: redirect.value,
          target: redirect.target,
          raw: redirect.raw,
          commandIndex,
          unresolved: redirect.unresolved.length > 0,
          cwd: currentCwd,
        };
        commandRedirects.push(node);
        redirects.push(node);
        for (const expansion of redirect.unresolved) unresolved.add(expansion);
        index += 1;
      }
      if (argv.length === 0) {
        words = [];
        cmdRedirects = [];
        incomplete = false;
        return;
      }
      const name = argv[0] ?? '';
      if (RESERVED_WORDS.has(name)) {
        incomplete = true;
        opaqueReasons.add(`shell keyword "${name}"`);
      }
      if (KNOWN_INTERPRETER(name)) {
        opaqueReasons.add(`interpreter "${name}"`);
      }
      for (const argument of argv.slice(1)) {
        if (SCRIPT_SUFFIXES.some((suffix) => argument.endsWith(suffix))) {
          opaqueReasons.add(`script "${argument}"`);
        }
      }
      if (
        name === 'eval' ||
        name === 'exec' ||
        name === 'source' ||
        name === '.'
      ) {
        opaqueReasons.add(`shell builtin "${name}" evaluates its input`);
      }
      commands.push({
        index: commandIndex,
        argv,
        raw: source.slice(
          words[0]?.start ?? 0,
          cmdRedirects.at(-1)?.end ?? words.at(-1)?.end ?? 0,
        ),
        assignments: commandAssignments,
        redirects: commandRedirects,
        incomplete,
        pipelineIndex,
        cwd: currentCwd,
      });
      if (name === 'cd') {
        if (pipelineState.seen) pipelineState.cd = true;
        const rawTarget = argv[1] === '--' ? argv[2] : argv[1];
        const target = rawTarget;
        if (
          target === undefined ||
          target.startsWith('-') ||
          target.startsWith('~') ||
          hasUnresolved(target)
        ) {
          currentCwd = null;
          cwdUncertain = true;
        } else if (target.startsWith('/')) {
          currentCwd = normalizePath(target);
          cwdUncertain = false;
        } else if (currentCwd !== null) {
          currentCwd = normalizePath(`${currentCwd}/${target}`);
        } else {
          cwdUncertain = true;
        }
      }
      words = [];
      cmdRedirects = [];
      incomplete = false;
    };

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (token === undefined) continue;
      if (token.kind === 'word') {
        words.push(token);
        for (const expansion of token.unresolved) unresolved.add(expansion);
        substitutions += token.substitutions;
        continue;
      }
      if (token.kind === 'redirect') {
        cmdRedirects.push(token);
        for (const expansion of token.unresolved) unresolved.add(expansion);
        if (token.value === '<<' || token.value === '<<-') {
          incomplete = true;
          opaqueReasons.add('heredoc');
        }
        continue;
      }
      // Operators.
      if (token.value === '(' || token.value === ')') {
        subshells += 1;
        incomplete = true;
        opaqueReasons.add('subshell');
        continue;
      }
      if (token.value === '{' || token.value === '}') {
        incomplete = true;
        continue;
      }
      if (token.value === '|' || token.value === '|&') {
        flush();
        pipelineState.seen = true;
        pipelineIndex += 1;
        continue;
      }
      if (token.value === '&&') {
        flush();
        if (pipelineState.seen && pipelineState.cd) {
          currentCwd = null;
          cwdUncertain = true;
        }
        pipelineState.seen = false;
        pipelineState.cd = false;
        pipelineIndex += 1;
        continue;
      }
      if (token.value === '||') {
        flush();
        // The right-hand side runs when the left side failed; the directory is
        // no longer statically known unless an absolute cd follows.
        currentCwd = null;
        cwdUncertain = true;
        pipelineState.seen = false;
        pipelineState.cd = false;
        pipelineIndex += 1;
        continue;
      }
      if (token.value === ';' || token.value === '\n' || token.value === ';;') {
        flush();
        if (pipelineState.seen && pipelineState.cd) {
          currentCwd = null;
          cwdUncertain = true;
        }
        pipelineState.seen = false;
        pipelineState.cd = false;
        pipelineIndex += 1;
        continue;
      }
      if (token.value === '&') {
        flush();
        currentCwd = null;
        cwdUncertain = true;
        pipelineState.seen = false;
        pipelineState.cd = false;
        background = true;
        incomplete = true;
        pipelineIndex += 1;
      }
    }
    flush();

    const nodes: string[] = [];
    if (commands.length > 0) nodes.push('command');
    if (redirects.length > 0) nodes.push('file_redirect');
    if (assignments.length > 0) nodes.push('variable_assignment');

    if (cwdUncertain) {
      opaqueReasons.add('working directory is not statically known');
    }
    const complete =
      !incomplete &&
      !cwdUncertain &&
      opaqueReasons.size === 0 &&
      unresolved.size === 0 &&
      tokenized.heredocs === 0 &&
      substitutions === 0 &&
      subshells === 0;

    return makeParse({
      status: 'ok',
      statements,
      commands,
      redirects,
      assignments,
      subshells,
      substitutions,
      heredocs: tokenized.heredocs,
      unresolved: [...unresolved],
      opaque: opaqueReasons.size > 0,
      opaqueReasons: [...opaqueReasons],
      completeness: complete
        ? 'complete'
        : commands.length > 0
          ? 'partial'
          : 'none',
      background,
      nodes,
      comments: tokenized.comments,
    });
  } catch (error) {
    return makeParse({
      status: 'error',
      statements: 0,
      commands: [],
      redirects: [],
      assignments: [],
      subshells: 0,
      substitutions: 0,
      heredocs: 0,
      unresolved: [],
      opaque: true,
      opaqueReasons: ['parse error'],
      completeness: 'none',
      background: false,
      nodes: [],
      comments: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function KNOWN_INTERPRETER(name: string): boolean {
  const base = name.split('/').at(-1) ?? name;
  return INTERPRETERS.has(base);
}

function hasUnresolved(value: string): boolean {
  return value.includes('$') || value.includes('`');
}

export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('/')) return normalizePath(path);
  if (path.startsWith('~')) return path;
  return normalizePath(`${cwd}/${path}`);
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}

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

/** Build the facts section; only observed effects are reported. */
export function buildFacts(
  parse: ShellParse,
  options: FactsOptions,
): FactsResult {
  if (parse.status === 'error') {
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

  const writes: string[] = [];
  const networkCommands: string[] = [];
  const credentialPaths: string[] = [];
  const pipelineExec: string[][] = [];
  const writesOutsideWorkspace: string[] = [];
  let expansionRisk: string | null = null;

  for (const command of parse.commands) {
    const name = command.argv[0] ?? '';
    const args = command.argv.slice(1);
    if (
      NETWORK_COMMANDS.has(name) ||
      (name === 'git' && args[0] === 'push') ||
      name === 'gh'
    ) {
      networkCommands.push(name);
    }
    if (name === 'curl' || name === 'wget') {
      const shellPipe = args.find((argument) =>
        ['sh', 'bash', 'zsh'].includes(argument),
      );
      const next = parse.commands.find(
        (other) => other.index === command.index + 1,
      );
      const pipedInterpreter =
        next !== undefined && INTERPRETERS.has(next.argv[0] ?? '')
          ? next.argv[0]
          : undefined;
      if (shellPipe !== undefined || pipedInterpreter !== undefined) {
        pipelineExec.push([name, shellPipe ?? pipedInterpreter ?? 'sh']);
      }
    }
    for (const argument of [name, ...args]) {
      if (
        CREDENTIAL_HINTS.some((hint) => argument.toLowerCase().includes(hint))
      ) {
        credentialPaths.push(argument);
      }
    }
    const writeTargets: { target: string; cwd: string | null }[] = [];
    if (['touch', 'mkdir', 'tee', 'truncate'].includes(name)) {
      for (const target of args.filter((arg) => !arg.startsWith('-'))) {
        writeTargets.push({ target, cwd: command.cwd });
      }
    }
    if (['cp', 'mv', 'install', 'rsync', 'dd'].includes(name)) {
      const last = args.at(-1);
      if (last !== undefined)
        writeTargets.push({ target: last, cwd: command.cwd });
    }
    if (['rm', 'shred', 'unlink', 'rmdir'].includes(name)) {
      for (const argument of args) {
        if (!argument.startsWith('-')) {
          writeTargets.push({ target: argument, cwd: command.cwd });
        }
      }
    }
    if (name === 'find' && args.includes('-delete')) {
      const first = args[0];
      if (first !== undefined)
        writeTargets.push({ target: first, cwd: command.cwd });
    }
    for (const redirect of command.redirects) {
      if (redirect.op.includes('>')) {
        writeTargets.push({ target: redirect.target, cwd: redirect.cwd });
      }
      if (hasUnresolved(redirect.target))
        expansionRisk = 'redirect target contains an unresolved expansion';
    }
    for (const { target, cwd } of writeTargets) {
      if (target === '' || target.startsWith('-')) continue;
      if (hasUnresolved(target)) {
        expansionRisk = 'write target contains an unresolved expansion';
        writes.push(target);
        continue;
      }
      let resolved: string;
      if (target.startsWith('/')) {
        resolved = normalizePath(target);
      } else {
        if (cwd === null) {
          expansionRisk = 'working directory is not statically known';
          writes.push(target);
          continue;
        }
        resolved = resolvePath(target, cwd);
      }
      writes.push(resolved);
      if (options.workspaceRoot !== null) {
        const root = normalizePath(options.workspaceRoot);
        const inside = resolved === root || resolved.startsWith(`${root}/`);
        if (!inside) writesOutsideWorkspace.push(resolved);
      }
    }
    for (const arg of args) {
      if (
        hasUnresolved(arg) &&
        ['rm', 'mv', 'dd', 'shred', 'find'].includes(name)
      ) {
        expansionRisk = 'destructive argument contains an unresolved expansion';
      }
    }
  }

  const observedWrites = [...new Set(writes)];
  return {
    facts: {
      version: 1,
      parse: { status: 'ok', statements: parse.statements },
      observed: {
        writes: observedWrites.slice(0, 30),
        networkCommands: [...new Set(networkCommands)].slice(0, 30),
        credentialPaths: [...new Set(credentialPaths)].slice(0, 30),
        pipelineExec: pipelineExec.slice(0, 10),
        substitutions: parse.substitutions,
        subshells: parse.subshells,
      },
      opaque: parse.opaque,
      opaqueReason: parse.opaqueReasons[0] ?? null,
      unresolvedExpansions: parse.unresolved.slice(0, 30),
      expansionRisk,
      completeness: parse.completeness,
      parentAuthorizationPresent: options.parentAuthorizationPresent,
      overlapsDeniedEffect: options.overlapsDeniedEffect,
      historyTruncated: options.historyTruncated,
      ...(observedWrites.length > 30 ? { truncated: true } : {}),
    },
    writesOutsideWorkspace,
  };
}

/** Convert a parse into the human-readable node list shown by the rule tester. */
export function nodeTypes(parse: ShellParse): string[] {
  const nodes = new Set<string>();
  if (parse.commands.length > 0) nodes.add('command');
  if (parse.redirects.length > 0) nodes.add('file_redirect');
  if (parse.assignments.length > 0) nodes.add('variable_assignment');
  if (parse.subshells > 0) nodes.add('subshell');
  if (parse.substitutions > 0) nodes.add('command_substitution');
  if (parse.heredocs > 0) nodes.add('heredoc');
  return [...nodes];
}
