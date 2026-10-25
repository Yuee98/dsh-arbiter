export type ShellCompleteness = 'complete' | 'partial' | 'none';

export interface ShellRedirect {
  readonly index: number;
  readonly op: string;
  readonly target: string;
  readonly raw: string;
  readonly commandIndex: number;
  readonly unresolved: boolean;
  /** Effective working directory for this redirect, or null when unknown. */
  readonly cwd: string | null;
}

export interface ShellAssignment {
  readonly index: number;
  readonly name: string;
  readonly value: string;
  readonly raw: string;
  readonly commandIndex: number;
}

export interface ShellCommand {
  readonly index: number;
  /** Normalized command words; unresolved expansions remain as `$NAME`. */
  readonly argv: readonly string[];
  readonly raw: string;
  readonly assignments: readonly ShellAssignment[];
  readonly redirects: readonly ShellRedirect[];
  readonly incomplete: boolean;
  readonly pipelineIndex: number;
  /** Effective working directory when this command runs, or null when unknown. */
  readonly cwd: string | null;
}

export interface ShellParse {
  readonly status: 'ok' | 'error';
  readonly statements: number;
  readonly commands: readonly ShellCommand[];
  readonly redirects: readonly ShellRedirect[];
  readonly assignments: readonly ShellAssignment[];
  readonly subshells: number;
  readonly substitutions: number;
  readonly heredocs: number;
  readonly unresolved: readonly string[];
  readonly opaque: boolean;
  readonly opaqueReasons: readonly string[];
  readonly completeness: ShellCompleteness;
  readonly background: boolean;
  readonly nodes: readonly string[];
  readonly argv: readonly string[];
  readonly comments: readonly string[];
  readonly error?: string;
}

export interface WordToken {
  readonly kind: 'word';
  readonly value: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly unresolved: readonly string[];
  readonly substitutions: number;
  readonly quoted: boolean;
}

export interface OperatorToken {
  readonly kind: 'op';
  readonly value: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly unresolved: readonly string[];
  readonly substitutions: number;
}

export interface RedirectToken {
  readonly kind: 'redirect';
  readonly value: string;
  readonly fd: string | null;
  readonly target: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly unresolved: readonly string[];
}

export type Token = WordToken | OperatorToken | RedirectToken;
