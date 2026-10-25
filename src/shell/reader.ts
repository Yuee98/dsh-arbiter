/** Stateful statement assembly over the conservative shell token stream. */
import { INTERPRETERS, RESERVED_WORDS, SCRIPT_SUFFIXES } from './constants.js';
import { hasUnresolved, normalizePath } from './paths.js';
import { tokenize } from './tokenize.js';
import type { TokenizedShell } from './tokenize.js';
import type {
  RedirectToken,
  ShellAssignment,
  ShellCommand,
  ShellParse,
  ShellRedirect,
  Token,
  WordToken,
} from './types.js';

export function makeParse(
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

class ShellReader {
  private readonly commands: ShellCommand[] = [];
  private readonly redirects: ShellRedirect[] = [];
  private readonly assignments: ShellAssignment[] = [];
  private readonly unresolved = new Set<string>();
  private readonly opaqueReasons = new Set<string>();
  private substitutions = 0;
  private subshells = 0;
  private statements = 0;
  private background = false;
  private incomplete = false;
  private pipelineIndex = 0;
  private words: WordToken[] = [];
  private cmdRedirects: RedirectToken[] = [];
  private currentCwd: string | null;
  private cwdUncertain: boolean;
  private readonly pipelineState = { seen: false, cd: false };
  private readonly known: Record<string, string> = {};

  private readonly source: string;

  constructor(source: string, initialCwd: string | undefined) {
    this.source = source;
    this.currentCwd = initialCwd ?? null;
    this.cwdUncertain = initialCwd === undefined;
  }

  private replaceKnown(value: string): string {
    for (const [key, replacement] of Object.entries(this.known)) {
      value = value.split(`$${key}`).join(replacement);
    }
    return value;
  }

  private recordExpansions(word: WordToken): void {
    for (const expansion of word.unresolved) {
      const simpleVariable =
        expansion.startsWith('$') &&
        !expansion.startsWith('${') &&
        !expansion.startsWith('$(');
      const name = simpleVariable ? expansion.slice(1) : '';
      if (name.length > 0 && Object.hasOwn(this.known, name)) continue;
      this.unresolved.add(expansion);
    }
  }

  private commandWords(commandIndex: number): {
    argv: string[];
    assignments: ShellAssignment[];
  } {
    const assignments: ShellAssignment[] = [];
    const argv: string[] = [];
    let assignmentPhase = true;
    for (const [index, word] of this.words.entries()) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(word.value);
      if (assignmentPhase && assignment !== null) {
        const name = assignment[1] ?? '';
        const value = this.replaceKnown(assignment[2] ?? '');
        this.known[name] = value;
        const node = { index, name, value, raw: word.raw, commandIndex };
        assignments.push(node);
        this.assignments.push(node);
        continue;
      }
      assignmentPhase = false;
      const value = this.replaceKnown(word.value);
      this.recordExpansions(word);
      argv.push(value);
    }
    return { argv, assignments };
  }

  private commandRedirects(commandIndex: number): ShellRedirect[] {
    const redirects: ShellRedirect[] = [];
    for (const [offset, redirect] of this.cmdRedirects.entries()) {
      const node: ShellRedirect = {
        index: this.words.length + offset,
        op: redirect.value,
        target: redirect.target,
        raw: redirect.raw,
        commandIndex,
        unresolved: redirect.unresolved.length > 0,
        cwd: this.currentCwd,
      };
      redirects.push(node);
      this.redirects.push(node);
      for (const expansion of redirect.unresolved)
        this.unresolved.add(expansion);
    }
    return redirects;
  }

  private markOpaque(argv: readonly string[]): void {
    const name = argv[0] ?? '';
    if (RESERVED_WORDS.has(name)) {
      this.incomplete = true;
      this.opaqueReasons.add(`shell keyword "${name}"`);
    }
    if (INTERPRETERS.has(name.split('/').at(-1) ?? name)) {
      this.opaqueReasons.add(`interpreter "${name}"`);
    }
    for (const argument of argv.slice(1)) {
      if (SCRIPT_SUFFIXES.some((suffix) => argument.endsWith(suffix))) {
        this.opaqueReasons.add(`script "${argument}"`);
      }
    }
    if (['eval', 'exec', 'source', '.'].includes(name)) {
      this.opaqueReasons.add(`shell builtin "${name}" evaluates its input`);
    }
  }

  private changeDirectory(argv: readonly string[]): void {
    if (argv[0] !== 'cd') return;
    if (this.pipelineState.seen) this.pipelineState.cd = true;
    const target = argv[1] === '--' ? argv[2] : argv[1];
    if (
      target === undefined ||
      target.startsWith('-') ||
      target.startsWith('~') ||
      hasUnresolved(target)
    ) {
      this.currentCwd = null;
      this.cwdUncertain = true;
    } else if (target.startsWith('/')) {
      this.currentCwd = normalizePath(target);
      this.cwdUncertain = false;
    } else if (this.currentCwd !== null) {
      this.currentCwd = normalizePath(`${this.currentCwd}/${target}`);
    } else {
      this.cwdUncertain = true;
    }
  }

  private resetCommand(): void {
    this.words = [];
    this.cmdRedirects = [];
    this.incomplete = false;
  }

  private flush(): void {
    if (this.words.length === 0 && this.cmdRedirects.length === 0) return;
    this.statements += 1;
    const commandIndex = this.commands.length;
    const { argv, assignments } = this.commandWords(commandIndex);
    const redirects = this.commandRedirects(commandIndex);
    if (argv.length === 0) {
      this.resetCommand();
      return;
    }
    this.markOpaque(argv);
    this.commands.push({
      index: commandIndex,
      argv,
      raw: this.source.slice(
        this.words[0]?.start ?? 0,
        this.cmdRedirects.at(-1)?.end ?? this.words.at(-1)?.end ?? 0,
      ),
      assignments,
      redirects,
      incomplete: this.incomplete,
      pipelineIndex: this.pipelineIndex,
      cwd: this.currentCwd,
    });
    this.changeDirectory(argv);
    this.resetCommand();
  }

  private endPipeline(forceUnknown: boolean): void {
    this.flush();
    if (forceUnknown || (this.pipelineState.seen && this.pipelineState.cd)) {
      this.currentCwd = null;
      this.cwdUncertain = true;
    }
    this.pipelineState.seen = false;
    this.pipelineState.cd = false;
    this.pipelineIndex += 1;
  }

  private operator(value: string): void {
    switch (value) {
      case '(':
      case ')':
        this.subshells += 1;
        this.incomplete = true;
        this.opaqueReasons.add('subshell');
        return;
      case '{':
      case '}':
        this.incomplete = true;
        return;
      case '|':
      case '|&':
        this.flush();
        this.pipelineState.seen = true;
        this.pipelineIndex += 1;
        return;
      case '&&':
      case ';':
      case '\n':
      case ';;':
        this.endPipeline(false);
        return;
      case '||':
        // A failed left-hand command makes the directory unknown.
        this.endPipeline(true);
        return;
      case '&':
        this.endPipeline(true);
        this.background = true;
        this.incomplete = true;
        return;
    }
  }

  private accept(token: Token): void {
    if (token.kind === 'word') {
      this.words.push(token);
      for (const expansion of token.unresolved) this.unresolved.add(expansion);
      this.substitutions += token.substitutions;
      return;
    }
    if (token.kind === 'redirect') {
      this.cmdRedirects.push(token);
      for (const expansion of token.unresolved) this.unresolved.add(expansion);
      if (token.value === '<<' || token.value === '<<-') {
        this.incomplete = true;
        this.opaqueReasons.add('heredoc');
      }
      return;
    }
    this.operator(token.value);
  }

  private result(tokenized: TokenizedShell): ShellParse {
    const nodes: string[] = [];
    if (this.commands.length > 0) nodes.push('command');
    if (this.redirects.length > 0) nodes.push('file_redirect');
    if (this.assignments.length > 0) nodes.push('variable_assignment');
    if (this.cwdUncertain)
      this.opaqueReasons.add('working directory is not statically known');
    const complete =
      !this.incomplete &&
      !this.cwdUncertain &&
      this.opaqueReasons.size === 0 &&
      this.unresolved.size === 0 &&
      tokenized.heredocs === 0 &&
      this.substitutions === 0 &&
      this.subshells === 0;
    return makeParse({
      status: 'ok',
      statements: this.statements,
      commands: this.commands,
      redirects: this.redirects,
      assignments: this.assignments,
      subshells: this.subshells,
      substitutions: this.substitutions,
      heredocs: tokenized.heredocs,
      unresolved: [...this.unresolved],
      opaque: this.opaqueReasons.size > 0,
      opaqueReasons: [...this.opaqueReasons],
      completeness: complete
        ? 'complete'
        : this.commands.length > 0
          ? 'partial'
          : 'none',
      background: this.background,
      nodes,
      comments: tokenized.comments,
    });
  }

  read(): ShellParse {
    const tokenized = tokenize(this.source);
    for (const token of tokenized.tokens) this.accept(token);
    this.flush();
    return this.result(tokenized);
  }
}

export function readShell(
  source: string,
  initialCwd: string | undefined,
): ShellParse {
  return new ShellReader(source, initialCwd).read();
}
