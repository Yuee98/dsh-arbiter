/**
 * Adapter from the `unbash` recovery AST to the shell model.
 *
 * The parser is a candidate, not a contract: it recovers from malformed input,
 * reports some problems as `errors`, and — as the probe that motivated this file
 * showed — silently drops other input (`echo (` produces a clean-looking command
 * with the `(` missing). Nothing here trusts "no errors" alone: the visitor
 * records the source range of every node it reads, and this module reports
 * whatever syntax was left over as `unparsed-source`.
 *
 * What the adapter does NOT decide: whether a word value is statically known
 * (`words.ts`), what effects were observed (`facts.ts`), or any policy outcome.
 * It converts structure and marks what it could not account for.
 */

import { parse } from 'unbash';
import type { ParsedScript } from 'unbash';
import { INTERPRETERS, SCRIPT_SUFFIXES } from './constants.js';
import { unconsumed } from './source.js';
import { walkScript } from './visitor.js';
import type { WalkResult } from './visitor.js';
import type { ShellCommand, ShellParse, ShellStructureIssue } from './types.js';

/** Longest source the adapter will walk, in UTF-16 code units. */
const SOURCE_BUDGET = 1_000_000;

/**
 * Effect-level opacity: a call whose effects the parse cannot see through.
 *
 * This is a fact about what runs, not a structural gap. An interpreter or an
 * unknown script has unknown effects, but its command text can still be matched
 * by a rule the user wrote for it.
 */
function effectReasons(result: WalkResult): string[] {
  const reasons = new Set<string>();
  for (const command of result.commands) {
    const name = command.argv[0];
    if (name === undefined) continue;
    const base = name.split('/').at(-1) ?? name;
    if (INTERPRETERS.has(base)) reasons.add(`interpreter "${name}"`);
    for (const argument of command.argv.slice(1)) {
      if (SCRIPT_SUFFIXES.some((suffix) => argument.endsWith(suffix))) {
        reasons.add(`script "${argument}"`);
      }
    }
    if (['eval', 'exec', 'source', '.'].includes(name)) {
      reasons.add(`shell builtin "${name}" evaluates its input`);
    }
  }
  return reasons.size === 0 ? [] : [...reasons];
}

function failedParse(message: string): ShellParse {
  return {
    status: 'error',
    statements: 0,
    commands: [],
    redirects: [],
    assignments: [],
    words: [],
    subshells: 0,
    substitutions: 0,
    heredocs: 0,
    unresolved: [],
    opaque: true,
    opaqueReasons: ['parse error'],
    completeness: 'none',
    structure: {
      issues: [{ kind: 'parse-error', message, pos: 0 }],
      errors: [message],
      nodes: 0,
    },
    background: false,
    nodes: [],
    argv: [],
    error: message,
  };
}

/**
 * Convert one command text into the shell model.
 *
 * The adapter parses the exact text the caller received and never rewrites it:
 * normalization only decides each word's matching text, so the raw request stays
 * the record of what will actually run.
 */
export function adaptShell(source: string, initialCwd?: string): ShellParse {
  let script: ParsedScript;
  try {
    script = parse(source);
  } catch (error) {
    // The candidate is not expected to throw; if it ever does, that is a
    // structural error, never a fabricated empty parse.
    return failedParse(error instanceof Error ? error.message : String(error));
  }
  const result = walkScript(script, source, initialCwd ?? null);
  const issues: ShellStructureIssue[] = [...result.issues];
  for (const gap of unconsumed(source, result.covered)) {
    issues.push({
      kind: 'unparsed-source',
      message: `unparsed source ${JSON.stringify(gap.text)}`,
      pos: gap.pos,
    });
  }
  if (source.length > SOURCE_BUDGET) {
    issues.push({
      kind: 'node-budget',
      message: `source exceeds ${String(SOURCE_BUDGET)} characters`,
      pos: SOURCE_BUDGET,
    });
  }
  return finish(result, issues);
}

/** Attach the AST's own pipe edges to the commands they connect. */
function withPipeTargets(
  commands: readonly ShellCommand[],
  links: ReadonlyMap<number, number>,
): ShellCommand[] {
  return commands.map((command) => {
    const target = links.get(command.index);
    return target === undefined ? command : { ...command, pipeTarget: target };
  });
}

function finish(
  result: WalkResult,
  issues: readonly ShellStructureIssue[],
): ShellParse {
  const completeness =
    issues.length === 0
      ? 'complete'
      : result.commands.length > 0
        ? 'partial'
        : 'none';
  const opaqueReasons = effectReasons(result);
  return {
    status: issues.length > 0 && result.commands.length === 0 ? 'error' : 'ok',
    statements: result.statements,
    commands: withPipeTargets(result.commands, result.pipeLinks),
    // Only a redirect that names a file is a path subject; descriptor
    // duplication and heredocs are not.
    redirects: result.redirects.filter((redirect) => redirect.kind === 'file'),
    assignments: result.assignments,
    words: result.words,
    subshells: result.subshells,
    substitutions: result.substitutions,
    heredocs: result.heredocs,
    unresolved: result.unresolved,
    opaque: opaqueReasons.length > 0,
    opaqueReasons,
    completeness,
    structure: {
      issues,
      errors: result.errors,
      nodes: result.nodes,
    },
    background: result.background,
    nodes: [],
    argv: result.commands[0]?.argv ?? [],
  };
}
