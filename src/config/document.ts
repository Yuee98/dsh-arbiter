/**
 * Sections shared by every configuration format.
 *
 * A format owns only its rule model. Modes, reviewer, policy, context, audit,
 * breaker and the review budget keep one parser so a new rule format cannot
 * silently change unrelated validation, and the rule-bearing part is supplied by
 * the format handler.
 */

import type {
  ArbiterConfig,
  CommandRule,
  ConfigError,
  ConfigWarning,
} from '../types.js';
import { asBoolean, asInteger } from './values.js';
import { ruleWarnings } from './rules.js';
import { parseModes, parseAudit, parseBreaker } from './runtime.js';
import { parseReviewer } from './reviewer.js';
import { parsePolicy } from './policy.js';
import { parseContext } from './context.js';
import { validateRules } from '../rules/match.js';

/** Everything an `ArbiterConfig` needs except the rules a format parses. */
export type ConfigSections = Omit<ArbiterConfig, 'rules' | 'format'>;

export function parseConfigSections(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ConfigSections {
  const modes = parseModes(raw, errors);
  const reviewer = parseReviewer(raw, errors);
  const policy = parsePolicy(raw, errors);
  const context = parseContext(raw, errors);
  const audit = parseAudit(raw, errors);
  const breaker = parseBreaker(raw, errors);
  const reviewBudget =
    raw['reviewBudget'] === null || raw['reviewBudget'] === undefined
      ? null
      : asInteger(raw['reviewBudget'], 0, 1, 1_000_000, 'reviewBudget', errors);
  if (breaker.windowDenials > breaker.windowSize)
    errors.push({
      path: 'breaker.windowDenials',
      message: 'must not exceed breaker.windowSize',
      code: 'relation.windowDenials',
    });
  return {
    enabled: asBoolean(raw['enabled'], true, 'enabled', errors),
    modes,
    reviewer,
    policy,
    context,
    audit,
    breaker,
    reviewBudget,
  };
}

/**
 * Compile-validate the parsed rules and assemble the document.
 *
 * Pattern compilation runs for every rule, including disabled ones, so a stored
 * rule cannot become invalid (or unexpectedly broad) only after it is enabled.
 */
export function finishDocument(
  sections: ConfigSections,
  rules: readonly CommandRule[],
  errors: ConfigError[],
  warnings: ConfigWarning[],
  sourceIndices?: readonly number[],
): ArbiterConfig {
  for (const error of validateRules(rules, sourceIndices)) {
    errors.push({
      path: error.path,
      message: `${error.message} (rule "${error.id}")`,
      code: error.code ?? 'rule.invalid',
      // `rule.invalid` renders `{message}`; the raw sentence stays the fallback.
      params: { ...error.params, id: error.id, message: error.message },
    });
  }
  warnings.push(...ruleWarnings(rules));
  return { ...sections, rules };
}
