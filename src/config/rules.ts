/**
 * Canonical rule validation.
 *
 * A rule is a stable id, an optional custom name, a scope (tool and agent), one
 * or more alternative conditions, and a verdict. Every supplied field is
 * validated strictly: a wrong type is an error, never a permissive default that
 * would widen what the rule allows. A disabled rule is still validated, because
 * it can be enabled later without another check.
 *
 * Match semantics belong to `src/rules/compile.ts`; this module only decides
 * which documents are valid and which fields apply to which target, so the
 * configuration page, the host save path and external file replacement share one
 * standard.
 */

import type {
  CommandRule,
  ConfigError,
  ConfigWarning,
  RuleCombine,
  RuleCondition,
  RuleKind,
  RuleMultiMode,
  RulePattern,
  RuleScope,
  RuleTarget,
  RuleVerdict,
} from '../types.js';
import { validateSelector } from '../rules/selector.js';
import { isRecord } from './values.js';

const RULE_TARGETS: readonly RuleTarget[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
  'argument',
];
const RULE_KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];
const RULE_VERDICTS: readonly RuleVerdict[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
];
const MULTI_MODES: readonly RuleMultiMode[] = ['any', 'all'];

/**
 * Read a supplied enum value.
 *
 * Unlike the generic configuration helper this never substitutes a default for a
 * supplied but unknown value: a typo in `verdict` must not silently become
 * `allow`. The returned fallback is only used when the field is absent.
 */
function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  errors: ConfigError[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string') {
    const match = allowed.find((entry) => entry === value);
    if (match !== undefined) return match;
  }
  errors.push({
    path,
    message: `must be one of ${allowed.join(', ')}`,
    code: 'enum.value',
    params: { values: allowed.join(', ') },
  });
  return fallback;
}

function optionalString(
  value: unknown,
  path: string,
  errors: ConfigError[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  errors.push({ path, message: 'must be a string', code: 'type.string' });
  return undefined;
}

function boolField(
  value: unknown,
  path: string,
  errors: ConfigError[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  errors.push({ path, message: 'must be a boolean', code: 'type.boolean' });
  return undefined;
}

/** A non-empty list of non-empty strings, or `undefined` when absent. */
function stringList(
  value: unknown,
  path: string,
  errors: ConfigError[],
  code: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({
      path,
      message: 'must be a non-empty array of strings',
      code,
    });
    return undefined;
  }
  const values: readonly unknown[] = value;
  if (values.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    errors.push({
      path,
      message: 'must be a non-empty array of strings',
      code,
    });
    return undefined;
  }
  return values.filter((entry): entry is string => typeof entry === 'string');
}

function parseScope(
  value: unknown,
  path: string,
  errors: ConfigError[],
): RuleScope | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object', code: 'type.object' });
    return undefined;
  }
  const tools = stringList(
    value['tools'],
    `${path}.tools`,
    errors,
    'rule.tools-empty',
  );
  const agents = stringList(
    value['agents'],
    `${path}.agents`,
    errors,
    'type.agent-scope',
  );
  for (const agent of agents ?? []) {
    if (
      agent !== 'main' &&
      agent !== 'subagent' &&
      !agent.startsWith('preset:')
    )
      errors.push({
        path: `${path}.agents`,
        message: `unknown agent identity "${agent}"`,
        code: 'rule.agent-unknown',
        params: { agent },
      });
  }
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(agents === undefined ? {} : { agents }),
  };
}

/**
 * A pattern is read as the JSON value the user wrote.
 *
 * `regex` and `glob` need text; `exact` may compare a string, number, boolean or
 * null so a tool argument keeps its type. An absent pattern is an error rather
 * than an empty string, because an empty expression is a much broader match.
 */
function parsePattern(
  value: unknown,
  kind: RuleKind,
  path: string,
  errors: ConfigError[],
): RulePattern | undefined {
  if (value === undefined) {
    errors.push({
      path,
      message: 'a match expression is required',
      code: 'rule.pattern-empty',
    });
    return undefined;
  }
  // `null` is a legal exact value and must survive parsing unchanged.
  if (kind === 'exact') {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value;
    errors.push({
      path,
      message: 'must be a string, number, boolean or null',
      code: 'rule.pattern-type',
    });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({
      path,
      message: `a ${kind} pattern must be a string`,
      code: 'rule.pattern-type',
      params: { kind },
    });
    return undefined;
  }
  if (value.length === 0) {
    errors.push({
      path,
      message: 'a match expression must not be empty',
      code: 'rule.pattern-empty',
    });
    return undefined;
  }
  return value;
}

/**
 * Unknown keys a document supplied, reported instead of silently dropped.
 *
 * A misspelled `combine` is the dangerous case: the rule keeps its declared
 * alternative semantics while the author believes they narrowed it. There is no
 * format left whose documents were already valid with a key this build ignores, so
 * every one of these is an error.
 */
function reportUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
  errors: ConfigError[],
  code: string,
): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    errors.push({
      path: `${path}.${key}`,
      message: `unknown field "${key}"`,
      code,
      params: { field: key },
    });
  }
}

const RULE_FIELDS = [
  'id',
  'name',
  'comment',
  'enabled',
  'scope',
  'combine',
  'conditions',
  'verdict',
  'hint',
] as const;

/**
 * The retired single-condition rule shape.
 *
 * Both retired formats wrote one `match` object per rule. Refusing it by name is
 * the difference between "this build dropped the format" and a stack of findings
 * about a missing `conditions` field: the operator has to rewrite the rule, and
 * nothing here converts it.
 */
const RETIRED_RULE_FIELD = 'match';

const CONDITION_FIELDS = [
  'target',
  'kind',
  'pattern',
  'caseSensitive',
  'path',
  'multi',
] as const;

function parseCondition(
  value: unknown,
  path: string,
  errors: ConfigError[],
): RuleCondition | null {
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object', code: 'type.object' });
    return null;
  }
  reportUnknownKeys(
    value,
    CONDITION_FIELDS,
    path,
    errors,
    'rule.unknown-field',
  );
  const target = enumField(
    value['target'],
    RULE_TARGETS,
    'command',
    `${path}.target`,
    errors,
  );
  const kind = enumField(
    value['kind'],
    RULE_KINDS,
    'exact',
    `${path}.kind`,
    errors,
  );
  const pattern = parsePattern(
    value['pattern'],
    kind,
    `${path}.pattern`,
    errors,
  );
  const caseSensitive = boolField(
    value['caseSensitive'],
    `${path}.caseSensitive`,
    errors,
  );
  const suppliedPath = optionalString(value['path'], `${path}.path`, errors);
  const suppliedMulti = enumField(
    value['multi'],
    MULTI_MODES,
    'any',
    `${path}.multi`,
    errors,
  );
  const multiSupplied = value['multi'] !== undefined;
  const pathSupplied = value['path'] !== undefined;

  if (target === 'argument') {
    if (suppliedPath === undefined) {
      if (!pathSupplied)
        errors.push({
          path: `${path}.path`,
          message: 'an argument condition requires a JSONPath expression',
          code: 'rule.path-required',
        });
    } else {
      const problem = validateSelector(suppliedPath);
      if (problem !== null)
        errors.push({
          path: `${path}.path`,
          message: `invalid JSONPath: ${problem}`,
          code: 'rule.path-invalid',
          params: { path: suppliedPath },
        });
    }
  } else {
    rejectForeignFields(path, target, { pathSupplied, multiSupplied }, errors);
  }

  // A missing or invalid pattern already produced an error, and the document is
  // invalid, so the placeholder is never matched. `null` is a real exact value:
  // `??` would erase it into an empty string, so only `undefined` is replaced.
  const resolved: RulePattern = pattern === undefined ? '' : pattern;
  return {
    target,
    ...(target === 'argument' && suppliedPath !== undefined
      ? { path: suppliedPath }
      : {}),
    kind,
    pattern: resolved,
    ...(caseSensitive === undefined ? {} : { caseSensitive }),
    ...(target === 'argument' ? { multi: suppliedMulti } : {}),
  };
}

/**
 * Reject a field that belongs to another target.
 *
 * Silently dropping such a field would change what the user asked the rule to do:
 * a `path` on a command condition reads as a narrowing the rule never had.
 */
function rejectForeignFields(
  path: string,
  target: RuleTarget,
  supplied: { readonly pathSupplied: boolean; readonly multiSupplied: boolean },
  errors: ConfigError[],
): void {
  if (supplied.pathSupplied)
    errors.push({
      path: `${path}.path`,
      message: 'path is only valid for the argument target',
      code: 'rule.path-scope',
      params: { target },
    });
  if (supplied.multiSupplied)
    errors.push({
      path: `${path}.multi`,
      message: 'multi is only valid for the argument target',
      code: 'rule.multi-scope',
      params: { target },
    });
}

export function parseRule(
  value: unknown,
  index: number,
  errors: ConfigError[],
): CommandRule | null {
  const path = `rules[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object', code: 'type.object' });
    return null;
  }
  if (value[RETIRED_RULE_FIELD] !== undefined) {
    // The rule keeps its old shape rather than being converted: a prefix-matching
    // (`regex`), negation-capable (`glob`) or selector-based rule has no provable
    // equivalent in this model, and both directions of a wrong guess are dangerous.
    errors.push({
      path,
      message: `"${RETIRED_RULE_FIELD}" belongs to a retired rule format; rewrite the rule with "conditions"`,
      code: 'rule.format-retired',
      params: { field: RETIRED_RULE_FIELD },
    });
    return null;
  }
  reportUnknownKeys(value, RULE_FIELDS, path, errors, 'rule.unknown-field');
  const id = optionalString(value['id'], `${path}.id`, errors)?.trim() ?? '';
  if (id.length === 0)
    errors.push({
      path: `${path}.id`,
      message: 'a rule id must not be empty',
      code: 'rule.id-empty',
    });
  const name = optionalString(value['name'], `${path}.name`, errors);
  if (name !== undefined && name.trim().length === 0)
    errors.push({
      path: `${path}.name`,
      message: 'a custom name must not be blank',
      code: 'rule.name-empty',
    });
  const scope = parseScope(value['scope'], `${path}.scope`, errors);
  const rawConditions = value['conditions'];
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    errors.push({
      path: `${path}.conditions`,
      message: 'a rule requires at least one condition',
      code: 'rule.conditions-empty',
    });
    return null;
  }
  const conditions: RuleCondition[] = [];
  rawConditions.forEach((condition, conditionIndex) => {
    const parsed = parseCondition(
      condition,
      `${path}.conditions[${String(conditionIndex)}]`,
      errors,
    );
    if (parsed !== null) conditions.push(parsed);
  });
  const verdict = enumField(
    value['verdict'],
    RULE_VERDICTS,
    'allow',
    `${path}.verdict`,
    errors,
  );
  const enabled = boolField(value['enabled'], `${path}.enabled`, errors);
  const comment = optionalString(value['comment'], `${path}.comment`, errors);
  const hint = optionalString(value['hint'], `${path}.hint`, errors);
  const combine = resolveCombine(value['combine'], rawConditions.length, {
    path: `${path}.combine`,
    errors,
  });
  return {
    id,
    combine,
    conditions,
    verdict,
    ...(name === undefined ? {} : { name }),
    ...(comment === undefined ? {} : { comment }),
    ...(hint === undefined ? {} : { hint }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * Read the rule-level connective.
 *
 * It is required whenever the choice actually matters, because the two readings
 * differ in the safe direction: `any` is wider, so guessing it would silently turn
 * a conjunction into a disjunction. A single condition keeps it optional — both
 * values judge identically — but a supplied value is preserved rather than
 * replaced by the default.
 */
function resolveCombine(
  value: unknown,
  conditionCount: number,
  context: {
    readonly path: string;
    readonly errors: ConfigError[];
  },
): RuleCombine {
  if (value !== undefined) {
    if (value === 'all' || value === 'any') return value;
    context.errors.push({
      path: context.path,
      message: 'must be one of all, any',
      code: 'enum.value',
      params: { values: 'all, any' },
    });
    return conditionCount > 1 ? 'any' : 'all';
  }
  if (conditionCount > 1) {
    context.errors.push({
      path: context.path,
      message:
        'a rule with several conditions must state "combine": "all" or "any"',
      code: 'rule.combine-required',
    });
    return 'any';
  }
  return 'all';
}

function literalPrefix(pattern: string): string {
  let source = pattern;
  if (source.startsWith('^')) source = source.slice(1);
  else if (source.startsWith('(?:^')) source = source.slice(4);
  let out = '';
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ('.*+?()[]{}|^$'.includes(char)) break;
    out += char;
  }
  return out;
}

/** The condition-level patterns a warning may compare. */
function comparablePatterns(rule: CommandRule): readonly string[] {
  return rule.conditions.flatMap((condition) =>
    typeof condition.pattern === 'string' ? [condition.pattern] : [],
  );
}

function sharesTargets(left: CommandRule, right: CommandRule): boolean {
  const targets = new Set(left.conditions.map((condition) => condition.target));
  return right.conditions.some((condition) => targets.has(condition.target));
}

/**
 * Non-blocking warnings.
 *
 * A force-review rule that overlaps an allow rule can make the allow ineffective.
 * The check only reports overlap it can actually justify from the expressions; it
 * never claims to detect every conflict and never blocks saving.
 */
export function ruleWarnings(rules: readonly CommandRule[]): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const allowRules = rules.filter(
    (rule) => rule.verdict === 'allow' && rule.enabled !== false,
  );
  const forceReviewRules = rules.filter(
    (rule) => rule.verdict === 'force-review' && rule.enabled !== false,
  );
  for (const allow of allowRules) {
    for (const review of forceReviewRules) {
      if (!sharesTargets(allow, review)) continue;
      if (allow.scope !== undefined || review.scope !== undefined) continue;
      const overlaps = comparablePatterns(allow).some((allowPattern) => {
        const allowPrefix = literalPrefix(allowPattern);
        return comparablePatterns(review).some((reviewPattern) => {
          const reviewPrefix = literalPrefix(reviewPattern);
          return (
            allowPattern === reviewPattern ||
            (reviewPrefix.length > 0 &&
              (allowPrefix.startsWith(reviewPrefix) ||
                reviewPrefix.startsWith(allowPrefix)))
          );
        });
      });
      if (overlaps)
        warnings.push({
          path: `rules.${allow.id}`,
          message: `allow rule "${allow.id}" may be shadowed by force-review rule "${review.id}"`,
          code: 'rule.shadowed',
          params: { allow: allow.id, review: review.id },
        });
    }
  }
  return warnings;
}
