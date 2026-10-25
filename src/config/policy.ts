import type {
  ConfigError,
  PolicyConfig,
  PolicyThresholds,
  ProbeMode,
} from '../types.js';
import {
  DEFAULT_NORMAL,
  DEFAULT_PROGRESS,
  POLICY_VERSION,
} from './defaults.js';
import { isRecord, asNumber, asInteger, asBoolean, asEnum } from './values.js';

function parseThresholds(
  value: unknown,
  fallback: PolicyThresholds,
  path: string,
  errors: ConfigError[],
): PolicyThresholds {
  if (!isRecord(value)) {
    if (value !== undefined)
      errors.push({ path, message: 'must be an object' });
    return fallback;
  }
  const probability = (
    key: 'tauAuth' | 'tauRisk' | 'tauCritical' | 'tauLow',
  ): number =>
    asNumber(value[key], fallback[key], 0, 1, `${path}.${key}`, errors);
  return {
    tauAuth: probability('tauAuth'),
    tauRisk: probability('tauRisk'),
    tauCritical: probability('tauCritical'),
    tauLow: probability('tauLow'),
    chatLowRiskMax: asInteger(
      value['chatLowRiskMax'],
      fallback.chatLowRiskMax,
      0,
      10,
      `${path}.chatLowRiskMax`,
      errors,
    ),
    chatMediumRiskMax: asInteger(
      value['chatMediumRiskMax'],
      fallback.chatMediumRiskMax,
      0,
      10,
      `${path}.chatMediumRiskMax`,
      errors,
    ),
    mediumRiskCeiling: asInteger(
      value['mediumRiskCeiling'],
      fallback.mediumRiskCeiling,
      0,
      10,
      `${path}.mediumRiskCeiling`,
      errors,
    ),
    explicitFromRisk: asInteger(
      value['explicitFromRisk'],
      fallback.explicitFromRisk,
      0,
      10,
      `${path}.explicitFromRisk`,
      errors,
    ),
    allowBulkEgress: asBoolean(
      value['allowBulkEgress'],
      fallback.allowBulkEgress,
    ),
  };
}

export function parsePolicy(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): PolicyConfig {
  const policyValue = isRecord(raw['policy']) ? raw['policy'] : {};
  const policy: PolicyConfig = {
    version: POLICY_VERSION,
    normal: parseThresholds(
      policyValue['normal'],
      DEFAULT_NORMAL,
      'policy.normal',
      errors,
    ),
    progress: parseThresholds(
      policyValue['progress'],
      DEFAULT_PROGRESS,
      'policy.progress',
      errors,
    ),
    probeMode: asEnum<ProbeMode>(
      policyValue['probeMode'],
      ['assist', 'override'],
      'assist',
      'policy.probeMode',
      errors,
    ),
  };

  return policy;
}
