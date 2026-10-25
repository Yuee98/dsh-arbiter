/**
 * RFC 9535 JSONPath selection for tool-call arguments.
 *
 * `$` is the tool-call arguments object itself, never a wrapper that includes
 * the tool name. Selection only chooses values: matching happens afterwards and
 * keeps JSON types, so a number, boolean, `null`, object or array is never
 * coerced into the string form of some other value. An invalid expression is a
 * configuration error and never collapses into "the field is missing".
 *
 * `jsonpath-rfc9535` implements the standard only, with no dependency of its own
 * and no JavaScript-expression extension, so a selector cannot turn into an
 * evaluation of user-supplied code.
 */

import { query } from 'jsonpath-rfc9535';
import type { JsonValue } from 'jsonpath-rfc9535';

/** A JSON scalar that exact matching may compare without stringification. */
export type JsonScalar = string | number | boolean | null;

export interface ArgSelector {
  /** The expression exactly as the user wrote it; used for display and errors. */
  readonly path: string;
  /** Typed values in document order; duplicates are preserved. */
  readonly select: (document: unknown) => readonly unknown[];
}

export class SelectorSyntaxError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = 'SelectorSyntaxError';
    this.path = path;
  }
}

function isJsonScalar(value: unknown): value is JsonScalar {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  return false;
}

/**
 * Convert a tool-call argument object into the value the expression runs on.
 *
 * Only JSON-compatible values are addressable; `undefined` members are dropped
 * so an absent field and an explicit `null` stay different, and values JSON
 * cannot represent (functions, symbols, class instances) are not silently
 * coerced into strings.
 */
function toDocument(value: unknown): JsonValue | undefined {
  if (isJsonScalar(value)) return value;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.flatMap((item) => {
      const converted = toDocument(item);
      return converted === undefined ? [] : [converted];
    });
  }
  if (typeof value === 'object') {
    const copy: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toDocument(item);
      if (converted !== undefined) copy[key] = converted;
    }
    return copy;
  }
  return undefined;
}

/** Validate one expression and report a stable, human-readable reason. */
export function selectorProblem(path: string): string | null {
  if (path.trim().length === 0) return 'the expression must not be empty';
  try {
    // The parser runs on a compiled grammar and does not evaluate the document,
    // so a probe against an empty object is enough to validate syntax.
    query({}, path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Compile one expression once; the same compiled selector serves validation,
 * the gate and the rule tester.
 */
export function compileSelector(path: string): ArgSelector {
  const problem = selectorProblem(path);
  if (problem !== null) throw new SelectorSyntaxError(path, problem);
  return {
    path,
    select: (document: unknown): readonly unknown[] => {
      const value = toDocument(document);
      if (value === undefined) return [];
      // RFC 9535 selection returns the selected JSON values in document order;
      // `undefined` cannot appear because the document never contains it.
      const selected: JsonValue[] = query(value, path);
      return selected;
    },
  };
}

/** Compilation-only helper for the configuration validator. */
export function validateSelector(path: string): string | null {
  return selectorProblem(path);
}
