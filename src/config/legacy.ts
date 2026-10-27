/**
 * Legacy (`arbiter-config-v1`) rule conversion.
 *
 * The old format matched with prefix semantics: RE2 used a search, globs left
 * negation and extglob enabled, and a tool selector navigated dot paths and
 * stringified numbers and booleans. The canonical format matches whole values
 * with fixed glob options and typed JSONPath selection.
 *
 * A legacy rule is therefore converted **only when equivalence is provable**.
 * Anything else is a blocking configuration error: the document is rejected, the
 * previous effective configuration keeps running, and the original file is left
 * untouched. Silently reinterpreting a legacy pattern under the new semantics
 * could either widen an `allow` or narrow a `deny`, and neither is acceptable.
 */

import type {
  CommandRule,
  ConfigError,
  RuleCondition,
  RuleVerdict,
} from '../types.js';
import { isRecord } from './values.js';

/** A legacy `match` object as it was written by the v1 format. */
interface LegacyMatch {
  readonly node: string;
  readonly kind: string;
  readonly pattern: unknown;
  readonly tool?: unknown;
  readonly selector?: unknown;
  readonly agents?: unknown;
}

const VERDICTS: ReadonlySet<string> = new Set([
  'allow',
  'deny',
  'force-ask',
  'force-review',
]);

function isVerdict(value: unknown): value is RuleVerdict {
  return typeof value === 'string' && VERDICTS.has(value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  const valid = items.every(
    (item) => typeof item === 'string' && item.length > 0,
  );
  if (!valid) return null;
  return items.filter((item): item is string => typeof item === 'string');
}

/**
 * Whether a legacy regex provably matches the whole value, so the v1 prefix
 * search and the canonical whole-value match agree.
 *
 * A simple "starts with `^`, ends with `$`" check is unsound: `^safe|bad$` starts
 * and ends with an anchor, yet the anchors bind the two alternatives separately,
 * so v1 matched `dangerbad` while whole-value matching does not. The proof
 * therefore requires a leading `^`, a trailing unescaped `$` at group depth 0
 * outside a character class, no alternation at group depth 0 (an alternation
 * inside a group still sits between the two anchors), and no inline multiline
 * flag or `\A`/`\z`/`\Z` boundary assertion.
 *
 * Everything else is rejected rather than guessed at. This is deliberately a
 * syntactic subset, not a regex equivalence decision procedure.
 */
export function isWholeValueRegex(pattern: string): boolean {
  if (!pattern.startsWith('^')) return false;
  // A local or global multiline flag makes `^`/`$` per-line assertions, which a
  // whole-value match cannot reproduce.
  if (MULTILINE_FLAG.test(pattern)) return false;
  const scan = scanRegex(pattern);
  return scan !== null && scan.trailingAnchor;
}

const MULTILINE_FLAG = /\(\?[a-zA-Z]*m[a-zA-Z]*(?::|\))/u;
const BOUNDARY_ASSERTIONS = new Set(['A', 'z', 'Z']);

interface RegexScan {
  readonly trailingAnchor: boolean;
}

/**
 * Walk the expression once, tracking character classes, escapes and group depth.
 *
 * Returns `null` for a construct the proof cannot accept: a boundary assertion,
 * or an alternation whose operands are not both inside the same group.
 */
function scanRegex(pattern: string): RegexScan | null {
  let inClass = false;
  let escaped = false;
  let depth = 0;
  let trailingAnchor = false;
  for (const char of pattern) {
    if (escaped) {
      escaped = false;
      if (BOUNDARY_ASSERTIONS.has(char)) return null;
      trailingAnchor = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      trailingAnchor = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      trailingAnchor = false;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === '|' && depth === 0) return null;
    trailingAnchor = char === '$';
  }
  return { trailingAnchor };
}

/**
 * Glob syntax whose meaning changed between the two formats.
 *
 * v1 left picomatch negation and extglob enabled; the canonical options disable
 * both so `!` and `?(` are literal text. A pattern using either construct
 * therefore cannot be converted without changing which values match.
 */
export function hasUnsupportedGlobSyntax(pattern: string): boolean {
  if (pattern.startsWith('!')) return true;
  return /(?:^|[^\\])[?*+@!]\(/u.test(pattern);
}

/**
 * Whether a legacy tool-scope value was a glob in v1.
 *
 * v1 compiled `match.tool` as a glob only when the value contained `*`; every
 * other value (including one containing `?`) was a literal equality check. The
 * canonical scope compiler keeps that rule, so only a `*` value can be a glob in
 * both formats — and only when no negation or extglob construct is present.
 */
export function legacyToolScope(tool: string): string | null {
  // v1 left picomatch negation enabled even for a value without `*`, so `!prod`
  // matched every tool *except* prod. The canonical scope matches that text
  // literally, so a value that starts with `!` cannot be carried over at all.
  if (tool.startsWith('!')) return null;
  if (!tool.includes('*')) return tool;
  if (hasUnsupportedGlobSyntax(tool)) return null;
  return tool;
}

function notConvertible(
  index: number,
  id: string,
  errors: ConfigError[],
  reason: string,
): null {
  errors.push({
    path: `rules[${String(index)}]`,
    message: `legacy rule "${id}" cannot be converted to the canonical rule model: ${reason}`,
    code: 'rule.not-convertible',
    params: { id, reason },
  });
  return null;
}

function readLegacyMatch(value: unknown): LegacyMatch | null {
  if (!isRecord(value)) return null;
  const node = value['node'];
  const kind = value['kind'];
  if (typeof node !== 'string' || typeof kind !== 'string') return null;
  return {
    node,
    kind,
    pattern: value['pattern'],
    ...(value['tool'] === undefined ? {} : { tool: value['tool'] }),
    ...(value['selector'] === undefined ? {} : { selector: value['selector'] }),
    ...(value['agents'] === undefined ? {} : { agents: value['agents'] }),
  };
}

/** Keys on a rule, or inside `match`, that only the canonical format defines. */
const CANONICAL_RULE_KEYS = ['conditions', 'scope', 'combine'] as const;
const CANONICAL_MATCH_KEYS = ['path', 'multi', 'caseSensitive'] as const;

/**
 * The canonical-only key a legacy document tried to use, if any.
 *
 * Accepting such a key would give an undeclared document the canonical semantics
 * the explicit format registry exists to prevent. Dropping it is worse: a `scope`
 * written to narrow an `allow` would silently disappear and widen the rule.
 */
export function canonicalKeyUsed(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of CANONICAL_RULE_KEYS) {
    if (value[key] !== undefined) return key;
  }
  const match = value['match'];
  if (isRecord(match)) {
    for (const key of CANONICAL_MATCH_KEYS) {
      if (match[key] !== undefined) return `match.${key}`;
    }
  }
  return null;
}

/**
 * Convert one legacy rule, or report why it cannot be converted.
 *
 * Equivalence cases:
 *   - `exact` compares by equality in both formats, for every structural target
 *     and for the tool name;
 *   - a `glob` without negation or extglob means the same text pattern;
 *   - a `regex` only when `isWholeValueRegex` proves a whole-value match;
 *   - a `command`/`file_redirect`/`variable_assignment` node is a structural
 *     target in both formats;
 *   - a `tool` node without a selector becomes a tool condition plus one tool
 *     scope entry, keeping the same conjunction and the same literal/glob split.
 *
 * Rejected cases:
 *   - any `selector`: dot navigation stringified numbers/booleans and flattened
 *     string arrays, which typed RFC 9535 selection cannot prove equivalent to;
 *   - a regex that is not provably whole-value: a prefix search is not a
 *     whole-value match;
 *   - a glob using negation or extglob: the canonical options do not interpret
 *     them, so the literal reading would be different.
 */
export function convertLegacyRule(
  value: unknown,
  index: number,
  errors: ConfigError[],
): CommandRule | null {
  if (!isRecord(value)) {
    const id = isRecord(value) ? value['id'] : undefined;
    return notConvertible(
      index,
      typeof id === 'string' ? id : '',
      errors,
      'the rule is not an object',
    );
  }
  const ruleId = typeof value['id'] === 'string' ? value['id'] : '';
  const match = readLegacyMatch(value['match']);
  const problem = legacyProblem(value, match);
  if (problem !== null) return notConvertible(index, ruleId, errors, problem);
  // `legacyProblem` has established a verdict and a match object by now.
  if (match === null) return null;
  const verdict = value['verdict'];
  if (!isVerdict(verdict)) return null;

  const condition = legacyCondition(match, index, ruleId, errors);
  if (condition === null) return null;
  const scope = legacyScope(match, index, ruleId, errors);
  if (scope === null) return null;

  const scopeField =
    scope.tools === undefined && scope.agents === undefined ? {} : { scope };
  return {
    id: ruleId,
    conditions: [condition],
    verdict,
    ...metadataOf(value),
    ...scopeField,
  };
}

/** Optional descriptive fields carried over unchanged. */
function metadataOf(value: Record<string, unknown>): {
  readonly name?: string;
  readonly comment?: string;
  readonly hint?: string;
  readonly enabled?: boolean;
} {
  return {
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(typeof value['comment'] === 'string'
      ? { comment: value['comment'] }
      : {}),
    ...(typeof value['hint'] === 'string' ? { hint: value['hint'] } : {}),
    ...(typeof value['enabled'] === 'boolean'
      ? { enabled: value['enabled'] }
      : {}),
  };
}

/** The first reason a rule cannot be converted, or `null` when it can. */
function legacyProblem(
  value: Record<string, unknown>,
  match: LegacyMatch | null,
): string | null {
  if (!isVerdict(value['verdict'])) return 'the verdict is missing or unknown';
  if (match === null)
    return 'the legacy "match" object is missing or malformed';
  if (match.selector !== undefined)
    return 'a legacy argument selector cannot be expressed with typed JSONPath selection without changing which values match';
  if (match.tool !== undefined && match.node !== 'tool')
    return '"tool" is only valid on a tool node';
  return null;
}

/** Tool and agent scope, or `null` when a legacy value cannot be carried over. */
function legacyScope(
  match: LegacyMatch,
  index: number,
  ruleId: string,
  errors: ConfigError[],
): {
  readonly tools?: readonly string[];
  readonly agents?: readonly string[];
} | null {
  let agents: readonly string[] | undefined;
  if (match.agents !== undefined) {
    const parsed = stringArray(match.agents);
    if (parsed === null) {
      notConvertible(index, ruleId, errors, 'the agent scope is malformed');
      return null;
    }
    agents = parsed;
  }
  let tools: readonly string[] | undefined;
  if (match.node === 'tool' && typeof match.tool === 'string') {
    const scopeEntry = legacyToolScope(match.tool);
    if (scopeEntry === null) {
      notConvertible(
        index,
        ruleId,
        errors,
        'the legacy tool name used negation or extglob syntax that the canonical scope options do not interpret',
      );
      return null;
    }
    tools = [scopeEntry];
  }
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(agents === undefined ? {} : { agents }),
  };
}

function isRulePattern(value: unknown): value is RuleCondition['pattern'] {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Whether the legacy pattern is legal for its kind. */
function patternProblem(match: LegacyMatch): string | null {
  if (match.kind === 'exact') {
    if (
      match.pattern === null ||
      typeof match.pattern === 'string' ||
      typeof match.pattern === 'number' ||
      typeof match.pattern === 'boolean'
    )
      return null;
    return 'the exact pattern is not a string, number, boolean or null';
  }
  if (typeof match.pattern !== 'string')
    return 'a regex or glob pattern must be a string';
  if (match.kind === 'regex' && !isWholeValueRegex(match.pattern))
    return 'an unanchored regex matched anywhere in the text under the legacy format but matches the whole value under the canonical format';
  if (match.kind === 'glob' && hasUnsupportedGlobSyntax(match.pattern))
    return 'the legacy glob used negation or extglob syntax that the canonical options do not interpret';
  return null;
}

function legacyCondition(
  match: LegacyMatch,
  index: number,
  ruleId: string,
  errors: ConfigError[],
): RuleCondition | null {
  if (match.node === 'tool' && typeof match.tool !== 'string') {
    notConvertible(
      index,
      ruleId,
      errors,
      'a legacy tool node must name its tool',
    );
    return null;
  }
  if (
    match.kind !== 'exact' &&
    match.kind !== 'regex' &&
    match.kind !== 'glob'
  ) {
    notConvertible(
      index,
      ruleId,
      errors,
      `unknown legacy match kind "${match.kind}"`,
    );
    return null;
  }
  const problem = patternProblem(match);
  if (problem !== null) {
    notConvertible(index, ruleId, errors, problem);
    return null;
  }
  const target = legacyTarget(match.node);
  if (target === null) {
    notConvertible(
      index,
      ruleId,
      errors,
      `unknown legacy match node "${match.node}"`,
    );
    return null;
  }
  // `patternProblem` has already rejected every value that is not a legal
  // pattern for this kind.
  const pattern = match.pattern;
  if (!isRulePattern(pattern)) return null;
  return { target, kind: match.kind, pattern };
}

function legacyTarget(node: string): RuleCondition['target'] | null {
  if (node === 'tool') return 'tool';
  if (
    node === 'command' ||
    node === 'file_redirect' ||
    node === 'variable_assignment'
  )
    return node;
  return null;
}
