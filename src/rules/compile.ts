/** Compile validated rule matchers shared by runtime evaluation and the tester. */
import picomatch from 'picomatch';
import { RE2JS } from 're2js';
import type {
  CommandRule,
  RuleCondition,
  RuleConditionOutcome,
  RuleConditionResult,
  RulePattern,
  RuleScope,
  RuleTarget,
} from '../types.js';
import { compileSelector, SelectorSyntaxError } from './selector.js';
import type { ArgSelector } from './selector.js';

export interface RuleCompileError {
  readonly id: string;
  readonly path: string;
  readonly message: string;
  readonly code?: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * A rule problem with a stable reason code.
 *
 * The code selects a localized sentence; `message` stays the developer-facing
 * English text inserted as `{message}` only for reasons that have no template.
 */
export class RuleCompileFailure extends Error {
  readonly code: string;
  readonly params: Readonly<Record<string, string | number>>;
  constructor(
    code: string,
    message: string,
    params: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'RuleCompileFailure';
    this.code = code;
    this.params = params;
  }
}

/**
 * One structural unit a condition can inspect.
 *
 * `unresolved` marks structure whose value could not be determined (for example
 * a redirect target containing a variable); such a subject can only produce
 * `unknown`, never a match or a plain mismatch.
 */
export interface Subject {
  readonly target: RuleTarget;
  /** Canonical matching text for structural targets, or the tool name. */
  readonly text: string;
  readonly nodeIndex: number;
  readonly unresolved: boolean;
}

/** Everything one call offers to rule conditions. */
export interface CallSubjects {
  readonly tool: string;
  readonly identity: string;
  readonly argumentsValue: unknown;
  readonly subjects: readonly Subject[];
  /** True when the shell structure itself could not be determined. */
  readonly structureUnknown: boolean;
  /** True when the structure is fully known, so coverage can be claimed. */
  readonly structureComplete: boolean;
}

function isScalar(value: unknown): value is RulePattern {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Strings are compared with optional case folding; numbers, booleans and null
 * compare by value and JSON type only.
 *
 * Objects and arrays never match an `exact` condition: serializing them would
 * invent a text form the user never wrote and could make two distinct values
 * equal.
 */
function exactMatcher(
  pattern: RulePattern,
  caseSensitive: boolean,
): (value: unknown) => boolean {
  if (typeof pattern === 'string') {
    const expected = caseSensitive ? pattern : pattern.toLowerCase();
    return (value: unknown) =>
      typeof value === 'string' &&
      (caseSensitive ? value : value.toLowerCase()) === expected;
  }
  if (typeof pattern === 'number' || typeof pattern === 'boolean') {
    return (value: unknown) => value === pattern;
  }
  return (value: unknown) => value === null;
}

/**
 * Glob options are fixed so an expression keeps one meaning over time.
 *
 * `dot` keeps dot-prefixed content matchable, negation is disabled because a
 * leading `!` is a literal character in a rule expression, `noext` disables
 * extglob, and `nocase` follows the condition's own case choice — the caller
 * passes an explicit boolean, so an omitted `caseSensitive` stays
 * case-sensitive.
 *
 * Nothing here anchors to a path, strips a directory, converts separators, or
 * reads the filesystem: `/` is only a text segment boundary, a field named `path`
 * is matched like any other text, and `..` is ordinary text rather than a parent
 * directory reference.
 */
function compileGlob(
  pattern: string,
  caseSensitive: boolean,
): (value: string) => boolean {
  const matcher = picomatch(pattern, {
    dot: true,
    nocase: !caseSensitive,
    nonegate: true,
    noext: true,
  });
  return (value: string) => matcher(value);
}

function compileRegex(
  pattern: string,
  caseSensitive: boolean,
): (value: string) => boolean {
  let regex: RE2JS;
  try {
    regex = RE2JS.compile(pattern, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  } catch (error) {
    throw new RuleCompileFailure(
      'rule.regex-syntax',
      error instanceof Error ? error.message : String(error),
    );
  }
  // `matches` requires the entire value to match. A leading `^` therefore stays
  // a legal assertion, but it never turns the expression into a prefix search,
  // and the expression itself is passed to RE2 unchanged.
  return (value: string) => regex.matches(value);
}

/** One condition compiled once, ready to test typed values. */
interface CompiledCondition {
  readonly condition: RuleCondition;
  readonly matches: (value: unknown) => boolean;
  readonly selector: ArgSelector | null;
}

function assertPatternType(condition: RuleCondition): void {
  const { pattern, kind } = condition;
  if (!isScalar(pattern))
    throw new RuleCompileFailure(
      'rule.pattern-type',
      'a pattern must be a string, number, boolean or null',
    );
  if (kind === 'exact') return;
  if (typeof pattern !== 'string')
    throw new RuleCompileFailure(
      'rule.pattern-type',
      `a ${kind} pattern must be a string`,
      { kind },
    );
  if (pattern.length === 0)
    throw new RuleCompileFailure(
      'rule.pattern-empty',
      'the match expression must not be empty',
      { kind },
    );
}

function compileCondition(condition: RuleCondition): CompiledCondition {
  assertPatternType(condition);
  const caseSensitive = condition.caseSensitive !== false;
  let selector: ArgSelector | null = null;
  if (condition.target === 'argument') {
    if (condition.path === undefined)
      throw new RuleCompileFailure(
        'rule.path-required',
        'an argument condition requires a JSONPath expression',
      );
    try {
      selector = compileSelector(condition.path);
    } catch (error) {
      throw new RuleCompileFailure(
        'rule.path-invalid',
        error instanceof Error ? error.message : String(error),
        { path: condition.path },
      );
    }
  }
  if (condition.kind === 'exact')
    return {
      condition,
      matches: exactMatcher(condition.pattern, caseSensitive),
      selector,
    };
  const pattern = condition.pattern;
  // `assertPatternType` guarantees a string for non-exact kinds.
  if (typeof pattern !== 'string')
    throw new RuleCompileFailure(
      'rule.pattern-type',
      `a ${condition.kind} pattern must be a string`,
    );
  const test =
    condition.kind === 'regex'
      ? compileRegex(pattern, caseSensitive)
      : compileGlob(pattern, caseSensitive);
  return {
    condition,
    // A non-string value has no text form to match and is simply not matched.
    matches: (value: unknown) =>
      typeof value === 'string' ? test(value) : false,
    selector,
  };
}

type ResultReason = NonNullable<RuleConditionResult['reason']>;

function conditionResult(
  index: number,
  condition: RuleCondition,
  outcome: RuleConditionOutcome,
  extra: Partial<RuleConditionResult> = {},
): RuleConditionResult {
  return {
    index,
    target: condition.target,
    kind: condition.kind,
    pattern: condition.pattern,
    outcome,
    ...(condition.path === undefined ? {} : { path: condition.path }),
    ...(condition.multi === undefined ? {} : { multi: condition.multi }),
    ...extra,
  };
}

function noMatch(
  index: number,
  condition: RuleCondition,
  reason: ResultReason,
  extra: Partial<RuleConditionResult> = {},
): RuleConditionResult {
  return conditionResult(index, condition, 'no-match', { reason, ...extra });
}

/**
 * Evaluate one argument condition over typed selected values.
 *
 * `any` needs one matching value. `all` needs at least one selected value and
 * every one of them to match: an empty selection never satisfies either mode,
 * and `all` does not claim anything about members that were not selected.
 */
function evaluateArgument(
  compiled: CompiledCondition,
  index: number,
  call: CallSubjects,
): RuleConditionResult {
  const { condition, selector } = compiled;
  if (selector === null)
    return noMatch(index, condition, 'missing', { values: [] });
  let values: readonly unknown[];
  try {
    values = selector.select(call.argumentsValue);
  } catch {
    // A selector is validated at load time, so this can only be a document the
    // engine cannot traverse. Reporting `unknown` keeps a broken evaluation from
    // being read as "the rule did not apply".
    return conditionResult(index, condition, 'unknown', {
      reason: 'parse-error',
    });
  }
  if (values.length === 0)
    return noMatch(index, condition, 'empty-selection', { values: [] });
  const matched = values.filter((value) => compiled.matches(value));
  const texts = matched
    .map((value) => displayValue(value))
    .filter((value): value is string => value !== null);
  const extra: Partial<RuleConditionResult> = {
    values,
    matchedValues: matched,
    ...(texts[0] === undefined ? {} : { matchedValue: texts[0] }),
  };
  const all = (condition.multi ?? 'any') === 'all';
  if (all)
    return conditionResult(
      index,
      condition,
      matched.length === values.length ? 'match' : 'no-match',
      {
        ...extra,
        reason:
          matched.length === values.length ? 'resolved' : 'value-mismatch',
      },
    );
  return conditionResult(
    index,
    condition,
    matched.length > 0 ? 'match' : 'no-match',
    { ...extra, reason: matched.length > 0 ? 'resolved' : 'value-mismatch' },
  );
}

/** A readable text for a matched value, or `null` when it has no text form. */
function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value === null) return 'null';
  return null;
}

function evaluateStructural(
  compiled: CompiledCondition,
  index: number,
  call: CallSubjects,
): RuleConditionResult {
  const { condition } = compiled;
  // The tool target names the tool itself; it is a fact about the call, never
  // unknown, and it covers the whole call when it allows.
  if (condition.target === 'tool') {
    return compiled.matches(call.tool)
      ? conditionResult(index, condition, 'match', {
          reason: 'resolved',
          matchedValue: call.tool,
        })
      : noMatch(index, condition, 'value-mismatch');
  }
  const subjects = call.subjects.filter(
    (subject) => subject.target === condition.target,
  );
  if (subjects.length === 0) {
    // Missing structure can mean two different things. A call that has no shell
    // structure at all (a non-shell tool) can never satisfy a command condition,
    // which is a fact. A shell call whose structure could not be determined is
    // unknown, because the missing node might have matched.
    return call.structureUnknown
      ? conditionResult(index, condition, 'unknown', {
          reason: 'unresolved-structure',
        })
      : noMatch(index, condition, 'missing');
  }
  // A certain match decides, even when other subjects are unresolved: the rule
  // did match, and an unknown sibling cannot take that back.
  const matched = subjects.filter(
    (subject) => !subject.unresolved && compiled.matches(subject.text),
  );
  if (matched.length > 0)
    return conditionResult(index, condition, 'match', {
      reason: 'resolved',
      // Every matching text, not only the first: coverage compares each subject
      // against what actually matched, so keeping one value would report an
      // uncovered node that the condition did cover.
      matchedValues: matched.map((subject) => subject.text),
      matchedValue: matched[0]?.text ?? '',
    });
  // No certain match. An unresolved sibling could still match, so the honest
  // answer is unknown rather than a mismatch — otherwise adding one known-safe
  // redirect would turn an undetermined call into a confident one.
  if (subjects.some((subject) => subject.unresolved))
    return conditionResult(index, condition, 'unknown', {
      reason: 'unresolved-structure',
    });
  return noMatch(index, condition, 'value-mismatch');
}

export interface ConditionEvaluation {
  readonly outcome: RuleConditionOutcome;
  readonly conditions: readonly RuleConditionResult[];
}

/** One compiled rule, ready for the evaluator and the tester. */
export interface CompiledRule {
  readonly rule: CommandRule;
  readonly index: number;
  readonly toolMatcher: ((tool: string) => boolean) | null;
  readonly conditions: readonly CompiledCondition[];
  readonly evaluate: (call: CallSubjects) => ConditionEvaluation;
}

function compileToolScope(
  tools: readonly string[] | undefined,
): ((tool: string) => boolean) | null {
  if (tools === undefined) return null;
  const matchers = tools.map((tool) =>
    tool.includes('*')
      ? compileGlob(tool, true)
      : (value: string) => value === tool,
  );
  return (tool: string) => matchers.some((matcher) => matcher(tool));
}

const KNOWN_AGENTS = new Set(['main', 'subagent']);

function validateAgentIdentities(agents: readonly string[] | undefined): void {
  if (agents === undefined) return;
  if (agents.length === 0)
    throw new RuleCompileFailure(
      'rule.agents-empty',
      'agents must not be empty when present',
    );
  for (const agent of agents) {
    if (!KNOWN_AGENTS.has(agent) && !agent.startsWith('preset:'))
      throw new RuleCompileFailure(
        'rule.agent-unknown',
        `unknown agent identity "${agent}"`,
        { agent },
      );
  }
}

function validateConditionShape(condition: RuleCondition): void {
  if (condition.target !== 'argument' && condition.path !== undefined)
    throw new RuleCompileFailure(
      'rule.path-scope',
      'path is only valid for the argument target',
      { target: condition.target },
    );
  if (condition.target !== 'argument' && condition.multi !== undefined)
    throw new RuleCompileFailure(
      'rule.multi-scope',
      'multi is only valid for the argument target',
      { target: condition.target },
    );
  if (condition.target === 'argument' && condition.path === undefined)
    throw new RuleCompileFailure(
      'rule.path-required',
      'an argument condition requires a JSONPath expression',
      { target: condition.target },
    );
}

function validateScope(scope: RuleScope | undefined): void {
  if (scope === undefined) return;
  if (scope.tools !== undefined) {
    if (scope.tools.length === 0)
      throw new RuleCompileFailure(
        'rule.tools-empty',
        'tools must not be empty when present',
      );
    for (const tool of scope.tools) {
      if (tool.length === 0)
        throw new RuleCompileFailure(
          'rule.tool-empty',
          'a tool entry must not be empty',
        );
    }
  }
  validateAgentIdentities(scope.agents);
}

function validateRuleShape(rule: CommandRule): void {
  if (rule.id.length === 0)
    throw new RuleCompileFailure('rule.id-empty', 'rule id must not be empty');
  if (rule.conditions.length === 0)
    throw new RuleCompileFailure(
      'rule.conditions-empty',
      'a rule requires at least one condition',
    );
  if (rule.name !== undefined && rule.name.trim().length === 0)
    throw new RuleCompileFailure(
      'rule.name-empty',
      'a custom name must not be blank',
    );
  validateScope(rule.scope);
  for (const condition of rule.conditions) validateConditionShape(condition);
}

/**
 * Validate one rule and return a compiled matcher.
 *
 * Compilation is the only place that accepts a regex, glob or JSONPath; both the
 * configuration page and the runtime gate call it, so a rule that loads is a
 * rule the tester can match.
 */
export function compileRule(rule: CommandRule, index: number): CompiledRule {
  validateRuleShape(rule);
  const conditions = rule.conditions.map((condition) =>
    compileCondition(condition),
  );
  const toolMatcher = compileToolScope(rule.scope?.tools);
  const agents = rule.scope?.agents;
  const scopedOut = (): ConditionEvaluation => ({
    outcome: 'no-match',
    conditions: conditions.map((compiled, conditionIndex) =>
      noMatch(conditionIndex, compiled.condition, 'scope'),
    ),
  });
  return {
    rule,
    index,
    toolMatcher,
    conditions,
    evaluate: (call: CallSubjects): ConditionEvaluation => {
      if (rule.enabled === false) return scopedOut();
      // Scope is a deterministic pre-filter, never an unknown: a call either has
      // this tool and identity or it does not.
      if (toolMatcher !== null && !toolMatcher(call.tool)) return scopedOut();
      if (agents !== undefined && !agents.includes(call.identity))
        return scopedOut();
      const results = conditions.map((compiled, conditionIndex) =>
        compiled.condition.target === 'argument'
          ? evaluateArgument(compiled, conditionIndex, call)
          : evaluateStructural(compiled, conditionIndex, call),
      );
      // Conditions are alternatives (OR): one certain match decides the rule, an
      // unknown only survives when nothing matched, and a rule that is entirely
      // determined not to match stays not-matched.
      const outcome: RuleConditionOutcome = results.some(
        (result) => result.outcome === 'match',
      )
        ? 'match'
        : results.some((result) => result.outcome === 'unknown')
          ? 'unknown'
          : 'no-match';
      return { outcome, conditions: results };
    },
  };
}

/**
 * Compile a rule list and collect every failure.
 *
 * `sourceIndices` maps each supplied rule back to its position in the original
 * document. A rule that was dropped while parsing (for example one with no
 * conditions) would otherwise shift every later path, so an error would point at
 * the wrong rule.
 */
export function compileRules(
  rules: readonly CommandRule[],
  sourceIndices?: readonly number[],
): {
  readonly compiled: readonly CompiledRule[];
  readonly errors: readonly RuleCompileError[];
} {
  const compiled: CompiledRule[] = [];
  const errors: RuleCompileError[] = [];
  const ids = new Set<string>();
  rules.forEach((rule, position) => {
    const index = sourceIndices?.[position] ?? position;
    if (ids.has(rule.id)) {
      errors.push({
        id: rule.id,
        path: `rules[${String(index)}].id`,
        message: 'duplicate rule id',
        code: 'rule.duplicateId',
        params: { id: rule.id },
      });
      return;
    }
    ids.add(rule.id);
    try {
      compiled.push(compileRule(rule, index));
    } catch (error) {
      errors.push({
        id: rule.id,
        path: `rules[${String(index)}]`,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof RuleCompileFailure
          ? { code: error.code, params: error.params }
          : error instanceof SelectorSyntaxError
            ? { code: 'rule.path-invalid', params: { path: error.path } }
            : {}),
      });
    }
  });
  return { compiled, errors };
}
