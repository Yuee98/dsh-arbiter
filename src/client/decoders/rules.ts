import type { RuleMatchDetail, RuleTestResult } from '../../types.js';
import { ruleNode, ruleVerdict } from './config.js';
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
} from './values.js';

function ruleMatch(value: unknown): RuleMatchDetail {
  const source = object(value);
  const hint = field(source, 'hint', optional(text));
  return {
    index: field(source, 'index', number),
    id: field(source, 'id', text),
    verdict: field(source, 'verdict', ruleVerdict),
    effective: field(source, 'effective', boolean),
    node: field(source, 'node', ruleNode),
    nodeIndex: field(source, 'nodeIndex', number),
    matchedText: field(source, 'matchedText', text),
    ...(hint === undefined ? {} : { hint }),
  };
}

function ruleResult(value: unknown): RuleTestResult {
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
    results: field(source, 'results', array(ruleResult)),
  };
}
