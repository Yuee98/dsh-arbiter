/**
 * Executable descendants inside words.
 *
 * A word's text range can be fully covered while the commands it runs live in parts
 * the shell evaluates lazily: the index and operation operands of `${...}`, the
 * expression of `$((...))`, and the command substitutions and process
 * substitutions anywhere in the tree. A generic object walk can miss these without
 * the parser reporting anything, so they are visited explicitly here.
 *
 * Nothing in this file decodes a value; it only ensures every executable node is
 * seen by the caller's sink, which records it as a subject or as an unresolved
 * expansion.
 */

import type {
  ArithmeticExpression,
  Script,
  TestExpression,
  Word,
  WordPart,
} from 'unbash';
import type { Frame } from './collected.js';
import type { ShellWord } from './types.js';

/** What expansion walking needs from the statement walker. */
export interface ExpansionSink {
  /** Record a word, including any expansions it contains. */
  recordWord(word: Word, frame: Frame): WordPartSink;
  /** Walk a script embedded in a substitution. */
  nestedScript(script: Script | undefined, frame: Frame): void;
  /** Note an expansion whose value is not statically known. */
  addUnresolved(text: string): void;
  /** Note that a substitution runs a command. */
  addSubstitution(): void;
}

/** Returned by `recordWord` so callers can read the value they just recorded. */
export interface WordPartSink {
  readonly reading: ShellWord;
}

/**
 * Visit every executable part of one word.
 *
 * The word's own text is already decoded (or kept raw) by the caller; this only
 * follows nested scripts and expansions so none of them disappears.
 */
export function visitParts(
  parts: readonly WordPart[],
  frame: Frame,
  sink: ExpansionSink,
): void {
  for (const part of parts) visitPart(part, frame, sink);
}

/** The nested parts a container part evaluates, when it has any. */
function containedParts(part: WordPart): readonly WordPart[] | null {
  if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
    return part.parts;
  }
  if (part.type === 'Glob') return part.kind === 'bracket' ? part.parts : null;
  if (part.type === 'BraceExpansion' || part.type === 'ExtendedGlob') {
    return part.parts ?? [];
  }
  return null;
}

function visitPart(part: WordPart, frame: Frame, sink: ExpansionSink): void {
  const contained = containedParts(part);
  if (contained !== null) {
    visitParts(contained, frame, sink);
    return;
  }
  if (part.type === 'CommandExpansion' || part.type === 'ProcessSubstitution') {
    sink.addSubstitution();
    sink.addUnresolved(part.text);
    sink.nestedScript(part.script, frame);
    return;
  }
  if (part.type === 'ParameterExpansion') {
    // The index and every operation operand can hold executable syntax.
    sink.addUnresolved(part.text);
    visitParameter(part, frame, sink);
    return;
  }
  if (part.type === 'ArithmeticExpansion') {
    sink.addUnresolved(part.text);
    if (part.expression !== undefined) {
      visitArithmetic(part.expression, frame, sink);
    }
    return;
  }
  if (part.type === 'SimpleExpansion') {
    sink.addUnresolved(part.text);
    return;
  }
  // AnsiCQuoted, Literal and SingleQuoted are already decoded into the word's
  // value; nothing executes here.
}

/** Visit the executable operands of a `${...}` expansion. */
function visitParameter(
  part: Extract<WordPart, { readonly type: 'ParameterExpansion' }>,
  frame: Frame,
  sink: ExpansionSink,
): void {
  if (part.index !== undefined) sink.recordWord(part.index, frame);
  const operation = part.operation;
  if (operation === undefined) return;
  switch (operation.type) {
    case 'Default':
    case 'Remove':
    case 'Transform':
      sink.recordWord(operation.operand, frame);
      return;
    case 'Replace':
      sink.recordWord(operation.pattern, frame);
      sink.recordWord(operation.replacement, frame);
      return;
    case 'Slice':
      sink.recordWord(operation.offset, frame);
      if (operation.length !== undefined)
        sink.recordWord(operation.length, frame);
      return;
    case 'CaseModification':
      if (operation.operand !== undefined)
        sink.recordWord(operation.operand, frame);
      return;
    case 'Names':
    case 'Unknown':
      return;
  }
}

/** Visit an arithmetic expression, including any nested command expansion. */
export function visitArithmetic(
  expression: ArithmeticExpression,
  frame: Frame,
  sink: ExpansionSink,
): void {
  switch (expression.type) {
    case 'ArithmeticWord':
      if (expression.parts !== undefined) {
        visitParts(expression.parts, frame, sink);
      }
      return;
    case 'ArithmeticBinary':
      visitArithmetic(expression.left, frame, sink);
      visitArithmetic(expression.right, frame, sink);
      return;
    case 'ArithmeticUnary':
      visitArithmetic(expression.operand, frame, sink);
      return;
    case 'ArithmeticTernary':
      visitArithmetic(expression.test, frame, sink);
      visitArithmetic(expression.consequent, frame, sink);
      visitArithmetic(expression.alternate, frame, sink);
      return;
    case 'ArithmeticGroup':
      visitArithmetic(expression.expression, frame, sink);
      return;
    case 'ArithmeticCommandExpansion':
      sink.nestedScript(expression.script, frame);
      return;
  }
}

/** Visit a `[[ ... ]]` expression's words, which can carry expansions. */
export function visitTest(
  expression: TestExpression,
  frame: Frame,
  sink: ExpansionSink,
): void {
  switch (expression.type) {
    case 'TestUnary':
      sink.recordWord(expression.operand, frame);
      return;
    case 'TestBinary':
      sink.recordWord(expression.left, frame);
      sink.recordWord(expression.right, frame);
      return;
    case 'TestLogical':
      for (const operand of expression.operands)
        visitTest(operand, frame, sink);
      return;
    case 'TestNot':
      visitTest(expression.operand, frame, sink);
      return;
    case 'TestGroup':
      visitTest(expression.expression, frame, sink);
      return;
  }
}
