import type {
  CommandRule,
  ConfigError,
  ConfigWarning,
  RuleKind,
  RuleMatchSpec,
  RuleNode,
  RuleVerdict,
} from '../types.js';
import { isRecord, asEnum } from './values.js';

const RULE_NODES: readonly RuleNode[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
];
const RULE_KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];
const RULE_VERDICTS: readonly RuleVerdict[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
];

/**
 * `agents` narrows a rule to specific identities. A supplied value must be a
 * non-empty list of strings: silently dropping a malformed scope would widen
 * the rule beyond what the user wrote.
 */
function parseAgents(
  value: unknown,
  path: string,
  errors: ConfigError[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({
      path,
      message: 'must be a non-empty array of strings',
      code: 'type.agent-scope',
    });
    return undefined;
  }
  const values: readonly unknown[] = value;
  if (values.some((agent) => typeof agent !== 'string')) {
    errors.push({
      path,
      message: 'must be a non-empty array of strings',
      code: 'type.agent-scope',
    });
    return undefined;
  }
  return values.filter((agent): agent is string => typeof agent === 'string');
}

/** A supplied string field; a present non-string is an error, absent is `undefined`. */
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

/**
 * A supplied `enabled` flag must be boolean: an invalid value must not silently
 * keep a rule enabled, which would widen what the configuration allows.
 */
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

function parseMatch(
  value: unknown,
  path: string,
  errors: ConfigError[],
): RuleMatchSpec | null {
  if (!isRecord(value)) {
    errors.push({
      path: `${path}.match`,
      message: 'must be an object',
      code: 'type.object',
    });
    return null;
  }
  const node = asEnum(
    value['node'],
    RULE_NODES,
    'command',
    `${path}.match.node`,
    errors,
  );
  const kind = asEnum(
    value['kind'],
    RULE_KINDS,
    'exact',
    `${path}.match.kind`,
    errors,
  );
  const pattern =
    optionalString(value['pattern'], `${path}.match.pattern`, errors) ?? '';
  const tool = optionalString(value['tool'], `${path}.match.tool`, errors);
  const selector = optionalString(
    value['selector'],
    `${path}.match.selector`,
    errors,
  );
  const agents = parseAgents(value['agents'], `${path}.match.agents`, errors);
  return {
    node,
    kind,
    pattern,
    ...(tool === undefined ? {} : { tool }),
    ...(selector === undefined ? {} : { selector }),
    ...(agents === undefined ? {} : { agents }),
  };
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
  const id = optionalString(value['id'], `${path}.id`, errors)?.trim() ?? '';
  const match = parseMatch(value['match'], path, errors);
  if (match === null) return null;
  const verdict = asEnum(
    value['verdict'],
    RULE_VERDICTS,
    'allow',
    `${path}.verdict`,
    errors,
  );
  const enabled = boolField(value['enabled'], `${path}.enabled`, errors);
  const comment = optionalString(value['comment'], `${path}.comment`, errors);
  const hint = optionalString(value['hint'], `${path}.hint`, errors);
  return {
    id,
    match,
    verdict,
    ...(comment === undefined ? {} : { comment }),
    ...(hint === undefined ? {} : { hint }),
    ...(enabled === undefined ? {} : { enabled }),
  };
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
      if (allow.match.node !== review.match.node) continue;
      if (allow.match.tool !== review.match.tool) continue;
      if (allow.match.selector !== review.match.selector) continue;
      if (allow.match.agents !== undefined || review.match.agents !== undefined)
        continue;
      const reviewPrefix = literalPrefix(review.match.pattern);
      const allowPrefix = literalPrefix(allow.match.pattern);
      if (
        review.match.pattern === allow.match.pattern ||
        (reviewPrefix.length > 0 &&
          (allowPrefix.startsWith(reviewPrefix) ||
            reviewPrefix.startsWith(allowPrefix)))
      ) {
        warnings.push({
          path: `rules.${allow.id}`,
          message: `allow rule "${allow.id}" may be shadowed by force-review rule "${review.id}"`,
          code: 'rule.shadowed',
          params: { allow: allow.id, review: review.id },
        });
      }
    }
  }
  return warnings;
}
