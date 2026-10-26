/**
 * Which sessions inherit one session's admission.
 *
 * A subagent has no record of its own: it is covered because its parent is, and
 * the host captured the parent's sandbox at delegation. That makes the branch
 * below a session load-bearing in two places — teardown must narrow it, and a
 * disable must not consider the subtree safe while any of it is still wide.
 *
 * The chain walk is bounded by `parentChain`, so a cyclic or unresolvable log
 * cannot loop here.
 */

import { parentChain } from './admission.js';

/** Whether `id` sits below `ancestor`, using the session lookup for parents. */
export function isBelow(
  id: string,
  ancestor: string,
  parentOf: (id: string) => string | undefined,
): boolean {
  if (id === ancestor) return false;
  return parentChain(id, parentOf).ids.slice(1).includes(ancestor);
}
