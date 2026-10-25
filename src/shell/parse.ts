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

import { readShell, makeParse } from './reader.js';
import type { ShellParse } from './types.js';
export type { ShellParse } from './types.js';
export { resolvePath } from './paths.js';
export { buildFacts } from './facts.js';

/** Parse failures are represented explicitly and never grant complete coverage. */
export function parseShell(source: string, initialCwd?: string): ShellParse {
  try {
    return readShell(source, initialCwd);
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
