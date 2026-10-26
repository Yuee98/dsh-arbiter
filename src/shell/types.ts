/**
 * The shell model the rule matcher reads.
 *
 * Three dimensions are recorded independently and never collapsed into one
 * "partial" flag:
 *
 *   - `structure` and `completeness` describe how much of the source the parser
 *     actually accounted for;
 *   - each {@link ShellWord} says whether its value was statically decodable, or
 *     else keeps the original expression and why it could not be decoded;
 *   - the facts layer (`facts.ts`) reports the effects it observed separately.
 *
 * A word is never invented: a dynamic word keeps the exact source text, and a
 * static word carries the decoded characters the shell would use.
 */
export type ShellCompleteness = 'complete' | 'partial' | 'none';

export type ShellWordStatus = 'static' | 'dynamic';

/** One word, with its matching text and the reason it could not be decoded. */
export interface ShellWord {
  /** Exactly what the user wrote for this word. */
  readonly raw: string;
  /**
   * Matching text: a canonical single-quote form for a static word, the raw
   * expression for a dynamic one. Words are joined with one space, so argument
   * boundaries and empty arguments survive.
   */
  readonly text: string;
  /** The decoded value, only when the word is static. */
  readonly value?: string;
  readonly status: ShellWordStatus;
  /** Why the word is dynamic, e.g. `variable` or `glob`; empty when static. */
  readonly reasons: readonly string[];
  /** The expansion fragments this word carries, for fact reporting. */
  readonly unresolved: readonly string[];
}

/** What a redirect names. Only `file` carries a path subject. */
export type ShellRedirectKind = 'file' | 'descriptor';

export interface ShellRedirect {
  readonly index: number;
  readonly op: string;
  /** Decoded target for a static word, raw expression for a dynamic one. */
  readonly target: string;
  readonly raw: string;
  readonly commandIndex: number;
  /** The target word is an expansion, so no path value is known. */
  readonly dynamic: boolean;
  /**
   * The effective path cannot be confirmed: the target is dynamic, it is relative
   * and the working directory is unknown, or it is relative and written in a body
   * that may run more than once.
   */
  readonly unresolved: boolean;
  /** Effective working directory for this redirect, or null when unknown. */
  readonly cwd: string | null;
  readonly kind: ShellRedirectKind;
}

export interface ShellAssignment {
  readonly index: number;
  readonly name: string;
  /** Matching text after `name=`: canonical when static, raw when dynamic. */
  readonly value: string;
  readonly dynamic: boolean;
  readonly raw: string;
  readonly commandIndex: number;
}

export interface ShellCommand {
  readonly index: number;
  /** Canonical matching text for the whole command, words joined by one space. */
  readonly text: string;
  readonly words: readonly ShellWord[];
  readonly argv: readonly string[];
  readonly raw: string;
  readonly pos: number;
  readonly end: number;
  readonly assignments: readonly ShellAssignment[];
  readonly redirects: readonly ShellRedirect[];
  readonly incomplete: boolean;
  readonly pipelineIndex: number;
  /**
   * Index of the command that receives this command's stdout through a real
   * `|`/`|&` in the same pipeline, or null when nothing is piped into.
   *
   * Adjacency in the source is not a pipe: two commands on separate lines run
   * sequentially, and only the AST's own operator proves an edge.
   */
  readonly pipeTarget: number | null;
  /** Effective working directory when this command runs, or null when unknown. */
  readonly cwd: string | null;
}

/** One reason the adapter could not account for the whole source. */
export interface ShellStructureIssue {
  readonly kind:
    'parse-error' | 'unparsed-source' | 'unterminated-heredoc' | 'node-budget';
  readonly message: string;
  readonly pos: number;
}

export interface ShellStructure {
  readonly issues: readonly ShellStructureIssue[];
  /** Raw parser messages, at every nesting level. */
  readonly errors: readonly string[];
  /** Syntax nodes visited before the adapter stopped. */
  readonly nodes: number;
}

export interface ShellParse {
  readonly status: 'ok' | 'error';
  readonly statements: number;
  readonly commands: readonly ShellCommand[];
  /** File redirects only; descriptor duplications and here-documents are not paths. */
  readonly redirects: readonly ShellRedirect[];
  readonly assignments: readonly ShellAssignment[];
  readonly words: readonly ShellWord[];
  readonly subshells: number;
  readonly substitutions: number;
  readonly heredocs: number;
  readonly unresolved: readonly string[];
  readonly opaque: boolean;
  readonly opaqueReasons: readonly string[];
  /** Structural completeness. Word values and facts are separate dimensions. */
  readonly completeness: ShellCompleteness;
  readonly structure: ShellStructure;
  readonly background: boolean;
  readonly nodes: readonly string[];
  readonly argv: readonly string[];
  readonly error?: string;
}

/** One word's normalization, as shown by the tester and the call detail. */
export interface NormalizationWord {
  /** Exactly what the user wrote. */
  readonly raw: string;
  /** The canonical matching text, or the raw expression when dynamic. */
  readonly text: string;
  readonly status: ShellWordStatus;
  /** Why the word is dynamic; empty when static. */
  readonly reasons: readonly string[];
  /** The decoded value, only when the word is static. */
  readonly value?: string;
}

export interface NormalizationCommand {
  /** Canonical matching text for the whole command. */
  readonly text: string;
  readonly raw: string;
  readonly words: readonly NormalizationWord[];
}

export interface NormalizationIssue {
  readonly kind: string;
  readonly message: string;
  readonly pos: number;
}

/**
 * Everything needed to explain how one command text became its matching text.
 *
 * Produced from the same parse the matcher used, so the explanation cannot
 * describe a different normalization than the one that decided the verdict.
 */
export interface NormalizationDetail {
  readonly raw: string;
  readonly completeness: ShellCompleteness;
  readonly issues: readonly NormalizationIssue[];
  readonly commands: readonly NormalizationCommand[];
}
