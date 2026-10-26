/**
 * Shared bookkeeping for the AST walk.
 *
 * The walk does not produce a verdict; it produces two things a caller must keep
 * apart: the nodes it actually read, and the source ranges those nodes cover. The
 * difference between them is how a silently dropped token is detected.
 */

import { normalizePath } from './paths.js';
import type {
  ShellAssignment,
  ShellCommand,
  ShellRedirect,
  ShellStructureIssue,
  ShellWord,
} from './types.js';

/** A hard stop on pathological input; exceeding it is a recorded issue. */
export const NODE_BUDGET = 20_000;

export interface CoveredRange {
  readonly start: number;
  readonly end: number;
}

/** Everything the walk produced, before the adapter finishes the model. */
export interface WalkResult {
  readonly commands: ShellCommand[];
  readonly redirects: ShellRedirect[];
  readonly assignments: ShellAssignment[];
  readonly words: ShellWord[];
  readonly unresolved: string[];
  readonly errors: string[];
  readonly issues: ShellStructureIssue[];
  readonly covered: CoveredRange[];
  /** Command indices linked by a real pipe operator: sender -> receiver. */
  readonly pipeLinks: ReadonlyMap<number, number>;
  readonly subshells: number;
  readonly substitutions: number;
  readonly heredocs: number;
  readonly background: boolean;
  readonly statements: number;
  readonly nodes: number;
}

/** Decoded value for a static word; the raw expression for a dynamic one. */
export function wordValue(word: ShellWord): string {
  return word.status === 'static' ? (word.value ?? word.text) : word.text;
}

/** Resolve the target of a `cd` word, or null when it cannot be known. */
export function resolveCd(
  value: string,
  word: ShellWord,
  cwd: string | null,
): string | null {
  if (word.status !== 'static') return null;
  if (value.length === 0 || value.startsWith('-') || value.startsWith('~')) {
    return null;
  }
  if (value.startsWith('/')) return normalizePath(value);
  return cwd === null ? null : normalizePath(`${cwd}/${value}`);
}

/**
 * Whether a redirect target can be resolved to an exact path.
 *
 * An absolute static target is known regardless of the working directory; a
 * relative one needs both a static word and a known directory.
 */
export function unresolvedTarget(
  reading: ShellWord | null,
  cwd: string | null,
  repeated = false,
): boolean {
  if (reading === null || reading.status === 'dynamic') return true;
  // A relative path in a body that may run more than once resolves against a
  // different directory on a later pass, so even a known cwd does not confirm it.
  if (repeated) return !wordValue(reading).startsWith('/');
  return !wordValue(reading).startsWith('/') && cwd === null;
}

/** Whether a redirect operator names a file the shell opens. */
export function redirectNamesFile(
  operator: string,
  target: string | undefined,
): boolean {
  if (operator === '>&' || operator === '<&') {
    // `2>&1` and `>&-` name a descriptor, not a path.
    return !/^(?:\d+|-)$/u.test(target ?? '');
  }
  return true;
}

export class Collected {
  readonly commands: ShellCommand[] = [];
  readonly redirects: ShellRedirect[] = [];
  readonly assignments: ShellAssignment[] = [];
  readonly words: ShellWord[] = [];
  readonly unresolved = new Set<string>();
  readonly errors: string[] = [];
  readonly issues: ShellStructureIssue[] = [];
  readonly covered: CoveredRange[] = [];
  /** Command indices linked by a real pipe: sender -> receiver. */
  readonly pipeLinks = new Map<number, number>();
  subshells = 0;
  substitutions = 0;
  heredocs = 0;
  background = false;
  statements = 0;
  nodes = 0;
  budgetExceeded = false;

  cover(start: number, end: number): void {
    this.covered.push({ start, end });
  }

  /**
   * Count one visited node.
   *
   * Returns true once the walk must stop; the budget issue is recorded exactly
   * once so a truncated walk never looks complete.
   */
  spend(): boolean {
    this.nodes += 1;
    if (this.nodes <= NODE_BUDGET) return false;
    if (!this.budgetExceeded) {
      this.budgetExceeded = true;
      this.issues.push({
        kind: 'node-budget',
        message: `stopped after ${String(NODE_BUDGET)} syntax nodes`,
        pos: 0,
      });
    }
    return true;
  }

  result(): WalkResult {
    return {
      commands: this.commands,
      redirects: this.redirects,
      assignments: this.assignments,
      words: this.words,
      unresolved: [...this.unresolved],
      errors: [...new Set(this.errors)],
      issues: this.issues,
      covered: this.covered,
      pipeLinks: this.pipeLinks,
      subshells: this.subshells,
      substitutions: this.substitutions,
      heredocs: this.heredocs,
      background: this.background,
      statements: this.statements,
      nodes: this.nodes,
    };
  }
}

/**
 * Walk state for one execution context.
 *
 * `cwd` is null as soon as the directory cannot be statically justified: a
 * dynamic `cd`, a `cd` in a pipeline or subshell, a background command, or a
 * branch that may run after a failure. Null is an honest "unknown", never the
 * caller's directory reused as a guess.
 */
export interface Frame {
  cwd: string | null;
  pipeline: number;
  /**
   * True while walking a body that can run more than once.
   *
   * A relative path written there may resolve against a different directory on a
   * later pass, so it cannot be confirmed even when this pass looks deterministic.
   */
  repeated: boolean;
}
