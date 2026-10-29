/**
 * The configuration document, from its sections to its rules.
 *
 * One parser owns the whole document. The rule model shares the document with the
 * modes, reviewer, policy, context, audit and breaker sections, so a change in one
 * of them cannot silently alter how the others are validated.
 */

import type {
  ArbiterConfig,
  CommandRule,
  ConfigError,
  ConfigWarning,
} from '../types.js';
import { asBoolean, asEnum, asInteger } from './values.js';
import { parseRule, ruleWarnings } from './rules.js';
import { parseModes, parseAudit, parseBreaker } from './runtime.js';
import { parseReviewer } from './reviewer.js';
import { parsePolicy } from './policy.js';
import { parseContext } from './context.js';
import { validateRules } from '../rules/match.js';

/** Everything an `ArbiterConfig` needs except the rules. */
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
    boundary: asEnum(
      raw['boundary'],
      ['guarded', 'trusted'],
      'guarded',
      'boundary',
      errors,
    ),
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
 * Read the whole document with the current rule model.
 *
 * Every rule is parsed strictly: an unknown key, or a rule with several conditions
 * that does not state `combine`, is an error. Deciding the connective from the
 * condition count is the one thing a reader must never do, because `any` is the
 * wider reading and the author may have meant the narrower one.
 */
export function parseConfigDocument(raw: Record<string, unknown>): {
  readonly config: ArbiterConfig;
  readonly errors: ConfigError[];
  readonly warnings: ConfigWarning[];
} {
  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];
  const sections = parseConfigSections(raw, errors);
  const rulesRaw = Array.isArray(raw['rules']) ? raw['rules'] : [];
  if (raw['rules'] !== undefined && !Array.isArray(raw['rules'])) {
    errors.push({
      path: 'rules',
      message: 'must be an array',
      code: 'type.array',
    });
  }
  const rules: CommandRule[] = [];
  const sourceIndices: number[] = [];
  rulesRaw.forEach((value, index) => {
    const rule = parseRule(value, index, errors);
    if (rule === null) return;
    rules.push(rule);
    sourceIndices.push(index);
  });
  const config = finishDocument(
    sections,
    rules,
    errors,
    warnings,
    sourceIndices,
  );
  return { config, errors, warnings };
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
