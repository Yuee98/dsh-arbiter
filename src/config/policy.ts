import type { ConfigError, PolicyConfig } from '../types.js';
import { POLICY_VERSION } from './defaults.js';
import { asObject, isRecord } from './values.js';

/**
 * The legacy policy fields this build no longer implements.
 *
 * They are named here so a document that still sets them is refused instead of
 * silently accepted: an operator who tuned `tauRisk` would otherwise believe a
 * setting still applied while the shared matrix decided everything. The message
 * names the replacement, because "unknown field" alone does not tell anyone what
 * to do.
 */
const RETIRED_THRESHOLDS: readonly string[] = [
  'tauAuth',
  'tauRisk',
  'tauCritical',
  'tauLow',
  'chatMediumRiskMax',
  'mediumRiskCeiling',
  'explicitFromRisk',
  'allowBulkEgress',
];

const RETIRED_REPLACEMENT =
  'the shared review matrix replaced the probability thresholds; remove this section';

/**
 * The review policy section.
 *
 * Only `version` remains. The matrix, the bands and the N0 rule are the shared
 * contract, whose own version names them, so a second set of numbers here would be
 * a second answer to the same question.
 */
export function parsePolicy(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): PolicyConfig {
  const policyValue = asObject(raw['policy'], 'policy', errors);
  // Both strategy blocks and the probe override are retired. Reporting them as
  // one error per present block keeps the message actionable rather than
  // enumerating eight absent fields.
  for (const block of ['normal', 'progress', 'probeMode'] as const) {
    if (policyValue[block] === undefined) continue;
    const value = policyValue[block];
    const retiredThresholds =
      isRecord(value) &&
      RETIRED_THRESHOLDS.some((field) => value[field] !== undefined);
    errors.push({
      path: `policy.${block}`,
      message: retiredThresholds
        ? RETIRED_REPLACEMENT
        : `"policy.${block}" is retired; the ask policy is set by "modes" and the matrix is the shared review contract`,
      code: 'policy.retired',
      params: { block },
    });
  }
  return { version: POLICY_VERSION };
}
