/**
 * Configuration shape, defaults, validation and normalization.
 *
 * The profile patch is the single editable source of truth. This module only
 * projects it into a complete effective configuration and reports errors; the
 * host keeps the last effective configuration when a candidate is invalid.
 */

import { validateRules } from './rules/match.js';
import type {
  ArbiterConfig,
  ApprovalMode,
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
} from './types.js';
import { DEFAULT_CONFIG } from './config/defaults.js';
import { isRecord, asBoolean, asInteger } from './config/values.js';
import { parseRule, ruleWarnings } from './config/rules.js';
import { parseModes, parseAudit, parseBreaker } from './config/runtime.js';
import { parseReviewer } from './config/reviewer.js';
import { parsePolicy } from './config/policy.js';
import { parseContext } from './config/context.js';
export { DEFAULT_CONFIG } from './config/defaults.js';

/**
 * Validate and normalize an arbitrary configuration value.
 *
 * Invalid fields keep their default value and are reported; the caller decides
 * whether to apply the candidate. Invalid individual rules are dropped only
 * after being reported, so a typo never silently becomes an allow.
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];
  if (!isRecord(raw)) {
    errors.push({ path: '', message: 'configuration must be an object' });
    return { config: DEFAULT_CONFIG, errors, warnings };
  }

  const modes = parseModes(raw, errors);
  const rulesRaw = Array.isArray(raw['rules']) ? raw['rules'] : [];
  if (raw['rules'] !== undefined && !Array.isArray(raw['rules'])) {
    errors.push({ path: 'rules', message: 'must be an array' });
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
    enabled: asBoolean(raw['enabled'], true),
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
    });
  }
  if (config.breaker.windowDenials > config.breaker.windowSize) {
    errors.push({
      path: 'breaker.windowDenials',
      message: 'must not exceed breaker.windowSize',
    });
  }
  warnings.push(...ruleWarnings(rules));
  return { config, errors, warnings };
}

/** A stable content identity for the effective configuration. */
export function configHash(config: ArbiterConfig): string {
  return stableHash(JSON.stringify(config));
}

/** Small deterministic FNV-1a hash; enough for a revision label, not a security hash. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function modeForSession(
  config: ArbiterConfig,
  sessionKind: 'main' | 'subagent',
): ApprovalMode {
  return sessionKind === 'main' ? config.modes.main : config.modes.subagent;
}
