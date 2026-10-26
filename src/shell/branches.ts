/**
 * Directory state across conditional constructs.
 *
 * An `if`, `case` or loop does not run exactly one known sequence of commands. Each
 * arm starts from the state its own condition or subject left, and the construct's
 * exit is the directory that *every* path through it agrees on. When they disagree
 * the answer is unknown — never the entry directory, and never whichever arm the
 * walk happened to visit last.
 *
 * No arm's writes are re-pointed here: the walk visits each arm with the right
 * starting state, so a relative redirect inside an arm is already resolved against
 * the directory that arm really runs in.
 */

import type { CompoundCommand, CompoundList } from 'unbash';
import type { Frame } from './collected.js';

/** Walks one statement list with a given frame. */
export type ListWalker = (list: CompoundList, frame: Frame) => void;

/** The one directory every path agrees on, or null. */
export function joinOutcomes(
  outcomes: readonly (string | null)[],
): string | null {
  const first = outcomes[0];
  if (first === undefined || first === null) return null;
  return outcomes.every((outcome) => outcome === first) ? first : null;
}

/** A frame for one arm, starting from `cwd`. */
function armFrame(frame: Frame, cwd: string | null): Frame {
  return { cwd, pipeline: frame.pipeline, repeated: frame.repeated };
}

/**
 * Walk an `if`/`elif`/`else` chain.
 *
 * The first condition runs unconditionally; every later condition runs only after
 * the previous ones failed, so it starts from the failing path's state. A body
 * starts from its own condition's exit, which is why `elif cd /tmp; then …` really
 * does run its body in `/tmp`.
 */
export function walkIf(
  node: Extract<CompoundCommand, { readonly type: 'If' }>,
  frame: Frame,
  walk: ListWalker,
): void {
  const entry = frame.cwd;
  const outcomes: (string | null)[] = [];
  walk(node.clause, frame);
  const thenEntry = frame.cwd;
  // A failed condition leaves the directory as it was, unless the succeeding path
  // took it somewhere indistinguishable.
  let failureEntry = entry === thenEntry ? entry : null;
  const thenArm = armFrame(frame, thenEntry);
  walk(node.then, thenArm);
  outcomes.push(thenArm.cwd);
  for (const arm of node.elif) {
    const clause = armFrame(frame, failureEntry);
    walk(arm.clause, clause);
    const bodyEntry = clause.cwd;
    const body = armFrame(frame, bodyEntry);
    walk(arm.then, body);
    outcomes.push(body.cwd);
    failureEntry = failureEntry === bodyEntry ? failureEntry : null;
  }
  if (node.else !== undefined) {
    const elseArm = armFrame(frame, failureEntry);
    walk(node.else, elseArm);
    outcomes.push(elseArm.cwd);
  } else {
    // No `else`: taking no arm leaves the directory where the failures left it.
    outcomes.push(failureEntry);
  }
  frame.cwd = joinOutcomes(outcomes);
}

/**
 * Walk a `case` construct.
 *
 * Every arm starts from the same state, and matching no arm is a real path.
 */
export function walkCase(
  node: Extract<CompoundCommand, { readonly type: 'Case' }>,
  frame: Frame,
  walk: ListWalker,
  recordWord: (word: (typeof node)['word']) => void,
): void {
  recordWord(node.word);
  const entry = frame.cwd;
  const outcomes: (string | null)[] = [];
  for (const item of node.items) {
    for (const pattern of item.pattern) recordWord(pattern);
    const arm = armFrame(frame, entry);
    walk(item.body, arm);
    outcomes.push(arm.cwd);
  }
  outcomes.push(entry);
  frame.cwd = joinOutcomes(outcomes);
}
