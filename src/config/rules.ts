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

export function parseRule(
  value: unknown,
  index: number,
  errors: ConfigError[],
): CommandRule | null {
  const path = `rules[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object' });
    return null;
  }
  const id = typeof value['id'] === 'string' ? value['id'].trim() : '';
  if (id.length === 0)
    errors.push({ path: `${path}.id`, message: 'must be a non-empty string' });
  const matchValue = value['match'];
  if (!isRecord(matchValue)) {
    errors.push({ path: `${path}.match`, message: 'must be an object' });
    return null;
  }
  const node = asEnum(
    matchValue['node'],
    RULE_NODES,
    'command',
    `${path}.match.node`,
    errors,
  );
  const kind = asEnum(
    matchValue['kind'],
    RULE_KINDS,
    'exact',
    `${path}.match.kind`,
    errors,
  );
  const pattern =
    typeof matchValue['pattern'] === 'string' ? matchValue['pattern'] : '';
  if (pattern.length === 0) {
    errors.push({
      path: `${path}.match.pattern`,
      message: 'must be a non-empty string',
    });
  }
  const match: RuleMatchSpec = {
    node,
    kind,
    pattern,
    ...(typeof matchValue['tool'] === 'string'
      ? { tool: matchValue['tool'] }
      : {}),
    ...(typeof matchValue['selector'] === 'string'
      ? { selector: matchValue['selector'] }
      : {}),
    ...(Array.isArray(matchValue['agents'])
      ? {
          agents: matchValue['agents'].filter(
            (agent): agent is string => typeof agent === 'string',
          ),
        }
      : {}),
  };
  const verdict = asEnum(
    value['verdict'],
    RULE_VERDICTS,
    'allow',
    `${path}.verdict`,
    errors,
  );
  const rule: CommandRule = {
    id,
    match,
    verdict,
    ...(typeof value['comment'] === 'string'
      ? { comment: value['comment'] }
      : {}),
    ...(typeof value['hint'] === 'string' ? { hint: value['hint'] } : {}),
    ...(typeof value['enabled'] === 'boolean'
      ? { enabled: value['enabled'] }
      : {}),
  };
  return rule;
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
        });
      }
    }
  }
  return warnings;
}
