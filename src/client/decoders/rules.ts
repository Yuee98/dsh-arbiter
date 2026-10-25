import type {
  RuleConditionResult,
  RuleMatchDetail,
  RuleResult,
  RuleTestResult,
} from '../../types.js';
import { ruleKind, ruleMulti, ruleTarget, ruleVerdict } from './config.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  optional,
  strings,
  text,
  unknownValue,
} from './values.js';

const OUTCOMES = choice('match', 'no-match', 'unknown');

function rulePattern(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  throw new TypeError('expected a string, number, boolean or null');
}

/** Typed selected values are opaque to the browser; only their count matters. */
function valueList(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('expected an array');
  const items: readonly unknown[] = value;
  return items.map((item) => unknownValue(item));
}

function conditionResult(value: unknown): RuleConditionResult {
  const source = object(value);
  const reason = field(
    source,
    'reason',
    optional(
      choice(
        'scope',
        'missing',
        'empty-selection',
        'unsupported-value',
        'value-mismatch',
        'resolved',
        'unresolved-structure',
        'parse-error',
      ),
    ),
  );
  const path = field(source, 'path', optional(text));
  const multi = field(source, 'multi', optional(ruleMulti));
  return {
    index: field(source, 'index', number),
    target: field(source, 'target', ruleTarget),
    kind: field(source, 'kind', ruleKind),
    pattern: field(source, 'pattern', rulePattern),
    outcome: field(source, 'outcome', OUTCOMES),
    ...(reason === undefined ? {} : { reason }),
    ...(path === undefined ? {} : { path }),
    ...(multi === undefined ? {} : { multi }),
    ...(source['values'] === undefined
      ? {}
      : { values: field(source, 'values', valueList) }),
    ...(source['matchedValues'] === undefined
      ? {}
      : { matchedValues: field(source, 'matchedValues', valueList) }),
  };
}

function ruleResult(value: unknown): RuleResult {
  const source = object(value);
  const name = field(source, 'name', optional(text));
  return {
    index: field(source, 'index', number),
    id: field(source, 'id', text),
    verdict: field(source, 'verdict', ruleVerdict),
    outcome: field(source, 'outcome', OUTCOMES),
    conditions: field(source, 'conditions', array(conditionResult)),
    ...(name === undefined ? {} : { name }),
  };
}

function ruleMatch(value: unknown): RuleMatchDetail {
  const source = object(value);
  const hint = field(source, 'hint', optional(text));
  const name = field(source, 'name', optional(text));
  return {
    index: field(source, 'index', number),
    id: field(source, 'id', text),
    verdict: field(source, 'verdict', ruleVerdict),
    effective: field(source, 'effective', boolean),
    target: field(source, 'target', ruleTarget),
    conditionIndex: field(source, 'conditionIndex', number),
    nodeIndex: field(source, 'nodeIndex', number),
    matchedText: field(source, 'matchedText', text),
    ...(name === undefined ? {} : { name }),
    ...(hint === undefined ? {} : { hint }),
  };
}

function ruleTest(value: unknown): RuleTestResult {
  const source = object(value);
  const parse = field(source, 'parse', object);
  const error = field(source, 'error', optional(text));
  return {
    input: field(source, 'input', text),
    tool: field(source, 'tool', text),
    path: field(
      source,
      'path',
      choice('allow', 'deny', 'force-ask', 'force-review', 'review(default)'),
    ),
    rule: field(source, 'rule', nullable(ruleMatch)),
    matches: field(source, 'matches', array(ruleMatch)),
    rules: field(source, 'rules', array(ruleResult)),
    parse: {
      status: field(parse, 'status', choice('ok', 'error')),
      statements: field(parse, 'statements', number),
      nodes: field(parse, 'nodes', strings),
      completeness: field(
        parse,
        'completeness',
        choice('complete', 'partial', 'none'),
      ),
      opaque: field(parse, 'opaque', boolean),
      unresolved: field(parse, 'unresolved', strings),
    },
    argv: field(source, 'argv', strings),
    shadowed: field(source, 'shadowed', strings),
    ...(error === undefined ? {} : { error }),
  };
}

export function ruleTestResponse(value: unknown) {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    results: field(source, 'results', array(ruleTest)),
  };
}
