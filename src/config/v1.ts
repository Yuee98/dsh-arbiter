/**
 * Format `arbiter-config-v1`: the current rule model and its prefix semantics.
 *
 * A later issue introduces the complete-match rule format; until then this
 * parser stays the single v1 implementation so existing files keep their
 * documented behavior instead of being silently reinterpreted.
 */

import { validateRules } from '../rules/match.js';
import type {
  ArbiterConfig,
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
  ExecutionBoundary,
} from '../types.js';
import { asBoolean, asEnum, asInteger } from './values.js';
import { parseRule, ruleWarnings } from './rules.js';
import { parseModes, parseAudit, parseBreaker } from './runtime.js';
import { parseReviewer } from './reviewer.js';
import { parsePolicy } from './policy.js';
import { parseContext } from './context.js';

/** Validate a v1 document; unlisted invalid fields keep their default value. */
export function parseConfigV1(raw: Record<string, unknown>): ConfigParseResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];
  const modes = parseModes(raw, errors);
  const rulesRaw = Array.isArray(raw['rules']) ? raw['rules'] : [];
  if (raw['rules'] !== undefined && !Array.isArray(raw['rules'])) {
    errors.push({
      path: 'rules',
      message: 'must be an array',
      code: 'type.array',
    });
  }
  const rules: CommandRule[] = [];
  rulesRaw.forEach((value, index) => {
    const rule = parseRule(value, index, errors);
    if (rule !== null) rules.push(rule);
  });

  const reviewer = parseReviewer(raw, errors);
  const policy = parsePolicy(raw, errors);
  const context = parseContext(raw, errors);
  const audit = parseAudit(raw, errors);
  const breaker = parseBreaker(raw, errors);
  const reviewBudget =
    raw['reviewBudget'] === null || raw['reviewBudget'] === undefined
      ? null
      : asInteger(raw['reviewBudget'], 0, 1, 1_000_000, 'reviewBudget', errors);

  const config: ArbiterConfig = {
    enabled: asBoolean(raw['enabled'], true, 'enabled', errors),
    boundary: asEnum<ExecutionBoundary>(
      raw['boundary'],
      ['guarded', 'trusted'],
      'guarded',
      'boundary',
      errors,
    ),
    modes,
    rules,
    reviewer,
    policy,
    context,
    audit,
    breaker,
    reviewBudget,
  };

  for (const error of validateRules(rules)) {
    errors.push({
      path: error.path,
      message: `${error.message} (rule "${error.id}")`,
      code: error.code ?? 'rule.invalid',
      // `rule.invalid` renders `{message}`; the raw sentence stays the fallback.
      params: { ...error.params, id: error.id, message: error.message },
    });
  }
  if (config.breaker.windowDenials > config.breaker.windowSize) {
    errors.push({
      path: 'breaker.windowDenials',
      message: 'must not exceed breaker.windowSize',
      code: 'relation.windowDenials',
    });
  }
  warnings.push(...ruleWarnings(rules));
  return { config, errors, warnings };
}
