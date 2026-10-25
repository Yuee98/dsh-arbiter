/**
 * Conversion of one parsed script into the shell model.
 *
 * The walk records every node it reads and the source range that node occupies.
 * The adapter (`ast.ts`) compares those ranges with the source, so a token the
 * parser silently dropped cannot be mistaken for "nothing else was there".
 *
 * Nested constructs the parser read reliably are part of the call: commands inside
 * substitutions, subshells, compound statements, function bodies and heredoc bodies
 * become ordinary command subjects, so a covering `allow` must cover them too.
 * Only structure the walk could not account for makes the result incomplete.
 */

import type {
  Assignment,
  Command,
  CompoundCommand,
  CompoundList,
  HereDoc,
  HereString,
  PipelineNode,
  Redirect,
  Redirected,
  Redirection,
  Script,
  Statement,
  Word,
} from 'unbash';
import {
  Collected,
  redirectNamesFile,
  resolveCd,
  unresolvedTarget,
  wordValue,
} from './collected.js';
import type { Frame, WalkResult } from './collected.js';

export type { WalkResult } from './collected.js';
import { visitArithmetic, visitParts, visitTest } from './expansions.js';
import type { ExpansionSink, WordPartSink } from './expansions.js';
import { unconsumed } from './source.js';
import { readShellWord } from './words.js';
import type {
  ShellAssignment,
  ShellCommand,
  ShellRedirect,
  ShellWord,
} from './types.js';

/** Parser messages attached to this script, in a typed shape. */
function parseErrors(script: Script): { message: string; pos: number }[] {
  const errors = 'errors' in script ? script.errors : undefined;
  if (!Array.isArray(errors)) return [];
  const parsed: { message: string; pos: number }[] = [];
  for (const error of errors) {
    if (
      error !== null &&
      typeof error === 'object' &&
      typeof Reflect.get(error, 'message') === 'string'
    ) {
      const pos: unknown = Reflect.get(error, 'pos');
      parsed.push({
        message: String(Reflect.get(error, 'message')),
        pos: typeof pos === 'number' ? pos : 0,
      });
    }
  }
  return parsed;
}

/** Constructs whose body may not run at all, so zero passes is a real path. */
const REPEATED = new Set<CompoundCommand['type']>([
  'For',
  'Select',
  'While',
  'ArithmeticFor',
]);

/**
 * The one directory every path out of a construct agrees on, or null.
 *
 * An empty path list cannot confirm anything, and a single unknown path is enough
 * to make the answer unknown.
 */
function joinOutcomes(outcomes: readonly (string | null)[]): string | null {
  const first = outcomes[0];
  if (first === undefined || first === null) return null;
  return outcomes.every((outcome) => outcome === first) ? first : null;
}

function redirectKind(redirection: Redirect): 'file' | 'descriptor' {
  return redirectNamesFile(redirection.operator, redirection.target?.text)
    ? 'file'
    : 'descriptor';
}

class AstVisitor implements ExpansionSink {
  private readonly collected: Collected;
  private readonly source: string;
  /**
   * Expansions discovered while building one node.
   *
   * Their nested commands are real commands the call runs, so they become their
   * own subjects; deferring them keeps the enclosing command first in the list and
   * lets the whole node be built before its children are visited.
   */
  private pending: (() => void)[] = [];

  constructor(collected: Collected, source: string) {
    this.collected = collected;
    this.source = source;
  }

  private spent(): boolean {
    // `Collected.spend` counts the node and records a one-time budget issue.
    return this.collected.spend();
  }

  private cover(start: number, end: number): void {
    this.collected.cover(start, end);
  }

  addUnresolved(text: string): void {
    this.collected.unresolved.add(text);
  }

  addSubstitution(): void {
    this.collected.substitutions += 1;
  }

  recordWord(word: Word, frame: Frame): WordPartSink {
    const reading = readShellWord(word.text, word.parts);
    this.collected.words.push(reading);
    for (const expansion of reading.unresolved) {
      this.collected.unresolved.add(expansion);
    }
    if (word.parts !== undefined) {
      const parts = word.parts;
      // The parts are visited once the enclosing node exists, so a command hidden
      // inside an expansion is appended after it rather than before it.
      this.pending.push(() => {
        visitParts(parts, frame, this);
      });
      // A command node defers its parts until it has been pushed; any other caller
      // (a redirect target, an assignment) must not lose them, so mark them for
      // the next flush as well.
    }
    this.cover(word.pos, word.end);
    return { reading };
  }

  /** Record a word and return its reading without deferring its parts. */
  private reading(word: Word, frame: Frame): ShellWord {
    return this.recordWord(word, frame).reading;
  }

  /**
   * Run the expansions deferred while one node was being built.
   *
   * Visiting a part can discover another word (a `${x:-$(...)}` operand), which
   * defers its own parts in turn, so the queue is drained rather than read once.
   */
  private flushPending(): void {
    while (this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const visit of queued) visit();
    }
  }

  nestedScript(script: Script | undefined, frame: Frame): void {
    if (script === undefined) return;
    if (script.source === undefined) {
      // A nested execution unit starts from the caller's directory, but its `cd`
      // cannot move the caller. Its commands are separate subjects: the outer
      // command's raw text contains the substitution, so covering only that text
      // has not covered what the substitution runs.
      new AstVisitor(this.collected, this.source).walkScript(script, {
        ...frame,
      });
      return;
    }
    // An escaped-backtick script has its own decoded source, so its positions
    // index that string and its gaps must be checked against it.
    const mark = this.collected.covered.length;
    new AstVisitor(this.collected, script.source).walkScript(script, {
      ...frame,
    });
    const ranges = this.collected.covered.splice(mark);
    for (const gap of unconsumed(script.source, ranges)) {
      this.collected.issues.push({
        kind: 'unparsed-source',
        message: `unparsed nested source ${JSON.stringify(gap.text)}`,
        pos: gap.pos,
      });
    }
  }

  private hereDoc(
    redirection: HereDoc,
    commandIndex: number,
    frame: Frame,
  ): void {
    this.collected.heredocs += 1;
    const body = redirection.body;
    this.cover(body.pos, body.end);
    if (redirection.closing === undefined) {
      this.collected.issues.push({
        kind: 'unterminated-heredoc',
        message: 'heredoc body is not closed by its delimiter',
        pos: redirection.pos,
      });
    } else {
      this.cover(redirection.closing.pos, redirection.closing.end);
    }
    // An unquoted delimiter makes the shell expand the body; a quoted delimiter
    // keeps the body literal, so only an unquoted body's expansions are real.
    if (redirection.delimiter?.quoted !== true && body.parts !== undefined) {
      visitParts(body.parts, frame, this);
    }
    // A heredoc feeds data, not a path, so it is not a file subject.
    this.collected.redirects.push({
      index: this.collected.redirects.length,
      op: redirection.operator,
      target: redirection.delimiter?.value ?? '',
      raw: this.source.slice(redirection.pos, redirection.end),
      commandIndex,
      dynamic: false,
      unresolved: true,
      cwd: frame.cwd,
      kind: 'descriptor',
    });
  }

  private hereString(
    redirection: HereString,
    commandIndex: number,
    frame: Frame,
  ): void {
    if (redirection.target !== undefined) {
      this.recordWord(redirection.target, frame);
    }
    this.collected.redirects.push({
      index: this.collected.redirects.length,
      op: redirection.operator,
      target: redirection.target?.text ?? '',
      raw: this.source.slice(redirection.pos, redirection.end),
      commandIndex,
      dynamic: redirection.target?.parts !== undefined,
      unresolved: true,
      cwd: frame.cwd,
      kind: 'descriptor',
    });
  }

  private redirect(
    redirection: Redirection,
    commandIndex: number,
    frame: Frame,
  ): void {
    if (redirection.type === 'HereDoc') {
      this.cover(redirection.pos, redirection.end);
      this.hereDoc(redirection, commandIndex, frame);
      return;
    }
    if (redirection.type === 'HereString') {
      this.cover(redirection.pos, redirection.end);
      this.hereString(redirection, commandIndex, frame);
      return;
    }
    const target = redirection.target;
    const reading = target === undefined ? null : this.reading(target, frame);
    if (target === undefined) {
      this.collected.issues.push({
        kind: 'parse-error',
        message: `redirect ${redirection.operator} has no target`,
        pos: redirection.pos,
      });
    }
    this.collected.redirects.push({
      index: this.collected.redirects.length,
      op: redirection.operator,
      target: reading === null ? '' : wordValue(reading),
      raw: this.source.slice(redirection.pos, redirection.end),
      commandIndex,
      dynamic: reading?.status === 'dynamic',
      unresolved: unresolvedTarget(reading, frame.cwd),
      cwd: frame.cwd,
      kind: redirectKind(redirection),
    });
    this.cover(redirection.pos, redirection.end);
  }

  private assignment(
    node: Assignment,
    commandIndex: number,
    frame: Frame,
  ): ShellAssignment {
    this.cover(node.pos, node.end);
    if (node.value.type === 'ArrayValue') {
      for (const element of node.value.elements) {
        this.recordWord(element, frame);
      }
      // The array's own text is known even though its elements are not: keeping
      // the original `name=(...)` form lets a rule match the assignment the user
      // wrote, while the elements stay separate subjects.
      const assignment: ShellAssignment = {
        index: this.collected.assignments.length,
        name: node.name,
        value: node.text.slice(node.name.length + 1),
        dynamic: true,
        raw: node.text,
        commandIndex,
      };
      this.collected.assignments.push(assignment);
      return assignment;
    }
    const reading = this.reading(node.value, frame);
    const assignment: ShellAssignment = {
      index: this.collected.assignments.length,
      name: node.name,
      value: wordValue(reading),
      dynamic: reading.status === 'dynamic',
      raw: node.text,
      commandIndex,
    };
    this.collected.assignments.push(assignment);
    return assignment;
  }

  private command(node: Command, frame: Frame): void {
    if (this.spent()) return;
    const commandIndex = this.collected.commands.length;
    const assignments: ShellAssignment[] = [];
    // Every redirect on this command — prefix and suffix — belongs to it, so the
    // facts layer can attribute the write without re-walking the global list.
    const redirects: ShellRedirect[] = [];
    const record = (redirection: Redirection): void => {
      const before = this.collected.redirects.length;
      this.redirect(redirection, commandIndex, frame);
      redirects.push(...this.collected.redirects.slice(before));
    };
    for (const prefix of node.prefix) {
      if (prefix.type === 'Assignment') {
        assignments.push(this.assignment(prefix, commandIndex, frame));
      } else {
        record(prefix);
      }
    }
    const words: ShellWord[] = [];
    if (node.name !== undefined) words.push(this.reading(node.name, frame));
    for (const entry of node.suffix) {
      if (entry.type === 'Word') {
        words.push(this.reading(entry, frame));
      } else if (entry.type === 'Assignment') {
        assignments.push(this.assignment(entry, commandIndex, frame));
      } else {
        record(entry);
      }
    }
    this.cover(node.pos, node.end);
    // A statement with only assignments or redirects has no command node; its
    // assignments and redirects were recorded as their own subjects, but their
    // expansions still execute.
    if (words.length > 0) {
      const command: ShellCommand = {
        index: commandIndex,
        text: words.map((word) => word.text).join(' '),
        words,
        argv: words.map(wordValue),
        raw: this.source.slice(node.pos, node.end),
        pos: node.pos,
        end: node.end,
        assignments,
        redirects,
        incomplete: false,
        pipelineIndex: frame.pipeline,
        pipeTarget: null,
        cwd: frame.cwd,
      };
      this.collected.commands.push(command);
      this.ownCommand = commandIndex;
      this.changeDirectory(command, frame);
    }
    this.flushPending();
  }

  /** Follow a static `cd` so later relative targets resolve from the new cwd. */
  private changeDirectory(command: ShellCommand, frame: Frame): void {
    const name = command.argv[0];
    if (name === undefined || name.split('/').at(-1) !== 'cd') return;
    const first = command.words[1];
    if (first === undefined) {
      frame.cwd = null;
      return;
    }
    if (wordValue(first) === '--') {
      const second = command.words[2];
      frame.cwd =
        second === undefined
          ? null
          : resolveCd(wordValue(second), second, command.cwd);
      return;
    }
    frame.cwd = resolveCd(wordValue(first), first, command.cwd);
  }

  private statementList(list: CompoundList, frame: Frame): void {
    for (const statement of list.commands) this.statement(statement, frame);
    this.cover(list.pos, list.end);
  }

  statement(statement: Statement, frame: Frame): void {
    if (this.spent()) return;
    if (statement.background === true) this.collected.background = true;
    if (statement.command.type === 'AndOr') {
      this.andOr(
        statement.command.commands,
        statement.command.operators,
        frame,
      );
    } else {
      this.node(statement.command, frame);
    }
    // A background command may still be running, so its directory changes cannot
    // be attributed to later commands in this input.
    if (statement.background === true) frame.cwd = null;
    this.cover(statement.pos, statement.end);
  }

  private node(node: PipelineNode, frame: Frame): void {
    if (this.spent()) return;
    this.collected.statements += 1;
    if (node.type === 'Command') {
      this.command(node, frame);
      return;
    }
    if (node.type === 'Pipeline') {
      this.pipeline(node, frame);
      return;
    }
    if (node.type === 'Redirected') {
      this.redirected(node, frame);
      return;
    }
    if (node.type === 'Function' || node.type === 'Coproc') {
      this.definition(node, frame);
      return;
    }
    this.compound(node, frame);
  }

  private pipeline(
    node: Extract<PipelineNode, { readonly type: 'Pipeline' }>,
    frame: Frame,
  ): void {
    // Each element runs in its own subshell with its own copy of the caller's
    // state. Sharing one mutable frame would let `cd X | echo hi > out` resolve the
    // redirect from X, even though the `cd` never moved the second element.
    // A pipe edge has to name the command that *is* the stage. A stage that is only
    // an assignment has no such command: in `x=$(curl …) | sh` the `curl` inside the
    // substitution runs, but its output is captured by the assignment, not piped to
    // `sh`. Recording the first extracted command would report that false edge.
    const stages: number[] = [];
    for (const element of node.commands) {
      stages.push(this.stageCommand(element, frame));
    }
    // A pipe edge exists only where the AST has an operator. Adjacent statements in
    // a script are sequential, not piped, so they get no link.
    for (const [index] of node.operators.entries()) {
      const sender = stages[index];
      const receiver = stages[index + 1];
      if (sender === undefined || receiver === undefined) continue;
      if (sender < 0 || receiver < 0) continue;
      this.collected.pipeLinks.set(sender, receiver);
    }
    // Elements cannot move the caller, so its directory is unchanged.
    frame.pipeline = frame.pipeline + 1;
    this.cover(node.pos, node.end);
  }

  /**
   * The command index that represents one pipeline stage, or -1 when none does.
   *
   * A stage whose own node is a command contributes that command. A compound stage
   * (`{ …; } | sh`) has no single command of its own, so it contributes nothing: the
   * pipe relationship is not confirmed and is not reported.
   */
  private stageCommand(element: PipelineNode, frame: Frame): number {
    const previous = this.ownCommand;
    this.ownCommand = null;
    this.node(element, { cwd: frame.cwd, pipeline: frame.pipeline + 1 });
    const own = this.takeOwnCommand(previous);
    // A stage that produced no command of its own (an assignment, a compound, a
    // construct whose own command never materialised) does not confirm a pipe.
    return own === null ? -1 : own;
  }

  /**
   * Restore the enclosing node's own command and report this stage's.
   *
   * A separate method keeps the answer opaque to the compiler's narrowing, which
   * would otherwise assume the field is still the null it was just assigned.
   */
  private takeOwnCommand(previous: number | null): number | null {
    const own = this.ownCommand;
    this.ownCommand = previous;
    return own;
  }

  private andOr(
    nodes: readonly PipelineNode[],
    operators: readonly ('&&' | '||')[],
    frame: Frame,
  ): void {
    // The right side of a conditional operator may not run at all, so the
    // directory the caller is in afterwards is the join of every path through the
    // list. Only a value all paths agree on survives.
    const entry = frame.cwd;
    for (const [index, command] of nodes.entries()) {
      if (operators[index - 1] === '||') {
        // The right side runs only after a failure, so the state the left side
        // would have left behind is not the one it starts in.
        frame.cwd = null;
      }
      this.node(command, frame);
    }
    if (operators.length > 0 && frame.cwd !== entry) frame.cwd = null;
  }

  private redirected(
    node: Extract<PipelineNode, { readonly type: 'Redirected' }>,
    frame: Frame,
  ): void {
    // The construct's redirects are opened before its body runs, so they resolve
    // from the directory on entry — `{ cd /tmp; } > out` writes to the caller's
    // `out`, not to `/tmp/out`.
    const entry: Frame = { cwd: frame.cwd, pipeline: frame.pipeline };
    this.node(node.command, frame);
    // They target the construct rather than the last command inside it, so no
    // command claims to write them and no subject is lost.
    for (const redirect of node.redirects) {
      this.redirect(redirect, this.collected.commands.length - 1, entry);
    }
    this.flushPending();
    this.cover(node.pos, node.end);
  }

  /**
   * Function and coproc definitions.
   *
   * The body is walked because its text is part of the call, but a definition does
   * not run it: it must not change the caller's directory, so the body gets its own
   * frame and the caller keeps the frame it had.
   */
  private definition(
    node: Extract<PipelineNode, { readonly type: 'Function' | 'Coproc' }>,
    frame: Frame,
  ): void {
    if (node.type === 'Function') {
      this.recordWord(node.name, frame);
      this.collected.subshells += 1;
    }
    this.nodeOrList(node.body, { cwd: frame.cwd, pipeline: frame.pipeline });
    this.flushPending();
    this.cover(node.pos, node.end);
  }

  private compound(node: CompoundCommand, frame: Frame): void {
    const entry = frame.cwd;
    this.compoundBody(node, frame);
    // Each construct decides its own join, because it alone knows which paths
    // through it exist. `if` and `case` compare their arms inside; a loop may run
    // zero times, so its body's exit has to agree with the entry state; a subshell
    // cannot move the caller at all.
    if (REPEATED.has(node.type) && frame.cwd !== entry) frame.cwd = null;
    this.flushPending();
    this.cover(node.pos, node.end);
  }

  /**
   * The command the node currently being visited produced for itself.
   *
   * Nested commands are pushed by the deferred expansion walk, so a caller cannot
   * tell "the stage's own command" from "a command found inside it" by counting.
   * This records the distinction at the one place that knows it.
   */
  private ownCommand: number | null = null;

  private compoundBody(node: CompoundCommand, frame: Frame): void {
    if (node.type === 'Subshell') {
      // `cd` inside a subshell does not move the caller.
      this.collected.subshells += 1;
      this.statementList(node.body, { ...frame });
      return;
    }
    if (node.type === 'BraceGroup' || node.type === 'ArithmeticFor') {
      this.statementList(node.body, frame);
      return;
    }
    if (node.type === 'If') {
      this.ifNode(node, frame);
      return;
    }
    if (node.type === 'For' || node.type === 'Select') {
      for (const word of node.wordlist ?? []) this.recordWord(word, frame);
      this.statementList(node.body, frame);
      return;
    }
    if (node.type === 'While') {
      this.statementList(node.clause, frame);
      this.statementList(node.body, frame);
      return;
    }
    if (node.type === 'Case') {
      this.caseNode(node, frame);
      return;
    }
    if (node.type === 'TestCommand') {
      visitTest(node.expression, frame, this);
      return;
    }
    if (node.expression !== undefined) {
      visitArithmetic(node.expression, frame, this);
    }
  }

  private caseNode(
    node: Extract<CompoundCommand, { readonly type: 'Case' }>,
    frame: Frame,
  ): void {
    this.recordWord(node.word, frame);
    const entry = frame.cwd;
    const outcomes: (string | null)[] = [];
    for (const item of node.items) {
      for (const pattern of item.pattern) this.recordWord(pattern, frame);
      const arm: Frame = { cwd: entry, pipeline: frame.pipeline };
      this.statementList(item.body, arm);
      outcomes.push(arm.cwd);
    }
    // Matching no arm is a real path: the directory then stays as it was.
    outcomes.push(entry);
    frame.cwd = joinOutcomes(outcomes);
  }

  private ifNode(
    node: Extract<CompoundCommand, { readonly type: 'If' }>,
    frame: Frame,
  ): void {
    // The condition runs first and is the only part every path shares.
    this.statementList(node.clause, frame);
    const afterCondition = frame.cwd;
    const outcomes: (string | null)[] = [];
    // Each arm starts from the directory the condition left, so a `cd` in one arm
    // cannot contaminate another arm's redirects.
    const branch = (list: CompoundList): void => {
      const inner: Frame = { cwd: afterCondition, pipeline: frame.pipeline };
      this.statementList(list, inner);
      outcomes.push(inner.cwd);
    };
    branch(node.then);
    for (const arm of node.elif) {
      this.statementList(arm.clause, {
        cwd: afterCondition,
        pipeline: frame.pipeline,
      });
      branch(arm.then);
    }
    if (node.else !== undefined) {
      branch(node.else);
    } else {
      // No `else` means "nothing happens", which leaves the directory as it was.
      outcomes.push(afterCondition);
    }
    frame.cwd = joinOutcomes(outcomes);
  }

  private nodeOrList(
    body: Command | CompoundCommand | Redirected | CompoundList,
    frame: Frame,
  ): void {
    if (body.type === 'CompoundList') {
      this.statementList(body, frame);
      return;
    }
    // A function body is a definition, but its text is still part of the call: an
    // inner deny must keep matching and an allow must cover it too.
    this.node(body, frame);
  }

  walkScript(script: Script, frame: Frame): void {
    for (const error of parseErrors(script)) {
      this.collected.errors.push(error.message);
      this.collected.issues.push({
        kind: 'parse-error',
        message: error.message,
        pos: error.pos,
      });
    }
    for (const statement of script.commands) this.statement(statement, frame);
    // The script's own range is NOT covered: the parser may have dropped tokens
    // between statements, and claiming the whole range would hide them.
  }
}

/**
 * Walk one script and return everything the adapter needs.
 *
 * Nested sources check their own unconsumed ranges as they are found; the caller
 * checks the outer source with the returned `covered` ranges.
 */
export function walkScript(
  script: Script,
  source: string,
  cwd: string | null,
): WalkResult {
  const collected = new Collected();
  new AstVisitor(collected, source).walkScript(script, { cwd, pipeline: 0 });
  return collected.result();
}
