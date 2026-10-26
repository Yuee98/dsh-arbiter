/**
 * A conservative shell reader for policy matching.
 *
 * dsh-arbiter needs the structure of a bash command — statements, pipelines,
 * redirects, assignments, subshells and expansions — not a full POSIX shell.
 * This module is the single entry point: `unbash` parses, the visitor converts
 * the recovery AST into the model in `types.ts`, and the caller gets three
 * independent dimensions instead of one global status:
 *
 *   - structure (`completeness`, `structure.issues`),
 *   - per-word static values (`words`, `commands[].words`),
 *   - observed effects (`buildFacts`).
 *
 * Policy never uses an incomplete structure to grant `allow`, and never treats a
 * dynamic word or a fact gap as proof of safety. Nothing here executes a command,
 * reads the environment, or expands a glob.
 */

import { adaptShell } from './ast.js';
import type { ShellParse } from './types.js';
export type { ShellParse } from './types.js';

export { resolvePath } from './paths.js';
export { buildFacts } from './facts.js';

/**
 * Parse failures are represented explicitly and never grant complete coverage.
 *
 * `adaptShell` already represents a candidate failure as a `status: 'error'`
 * parse; this wrapper keeps the public contract stable for callers.
 */
export function parseShell(source: string, initialCwd?: string): ShellParse {
  return adaptShell(source, initialCwd);
}

/** Convert a parse into the human-readable node list shown by the rule tester. */
export function nodeTypes(parse: ShellParse): string[] {
  const nodes: string[] = [];
  if (parse.commands.length > 0) nodes.push('command');
  if (parse.redirects.length > 0) nodes.push('file_redirect');
  if (parse.assignments.length > 0) nodes.push('variable_assignment');
  if (parse.subshells > 0) nodes.push('subshell');
  if (parse.substitutions > 0) nodes.push('command_substitution');
  if (parse.heredocs > 0) nodes.push('heredoc');
  return nodes;
}
