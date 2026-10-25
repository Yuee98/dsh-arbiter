import type {
  ArbiterConfig,
  ApprovalMode,
  SubagentMode,
  AuditConfig,
  BreakerConfig,
  BreakerPreset,
  ConfigError,
} from '../types.js';
import { isRecord, asEnum, asBoolean, asInteger } from './values.js';

export function parseModes(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ArbiterConfig['modes'] {
  const modesValue = isRecord(raw['modes']) ? raw['modes'] : {};
  const modes = {
    main: asEnum<ApprovalMode>(
      modesValue['main'],
      ['normal', 'strict', 'progress'],
      'normal',
      'modes.main',
      errors,
    ),
    subagent: asEnum<SubagentMode>(
      modesValue['subagent'],
      ['strict', 'progress'],
      'strict',
      'modes.subagent',
      errors,
    ),
  };

  return modes;
}

export function parseAudit(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): AuditConfig {
  const auditValue = isRecord(raw['audit']) ? raw['audit'] : {};
  const audit: AuditConfig = {
    enabled: asBoolean(auditValue['enabled'], true),
    retentionDays: asInteger(
      auditValue['retentionDays'],
      30,
      1,
      3_650,
      'audit.retentionDays',
      errors,
    ),
    retentionBytes: asInteger(
      auditValue['retentionBytes'],
      1024 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
      'audit.retentionBytes',
      errors,
    ),
    maxQueue: asInteger(
      auditValue['maxQueue'],
      500,
      1,
      100_000,
      'audit.maxQueue',
      errors,
    ),
  };

  return audit;
}

export function parseBreaker(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): BreakerConfig {
  const breakerValue = isRecord(raw['breaker']) ? raw['breaker'] : {};
  const breaker: BreakerConfig = {
    mode: asEnum<'off' | 'preset' | 'custom'>(
      breakerValue['mode'],
      ['off', 'preset', 'custom'],
      'preset',
      'breaker.mode',
      errors,
    ),
    preset: asEnum<BreakerPreset>(
      breakerValue['preset'],
      ['strict', 'balanced', 'lenient'],
      'balanced',
      'breaker.preset',
      errors,
    ),
    consecutiveDenials: asInteger(
      breakerValue['consecutiveDenials'],
      3,
      0,
      100,
      'breaker.consecutiveDenials',
      errors,
    ),
    windowDenials: asInteger(
      breakerValue['windowDenials'],
      6,
      0,
      100,
      'breaker.windowDenials',
      errors,
    ),
    windowSize: asInteger(
      breakerValue['windowSize'],
      10,
      1,
      100,
      'breaker.windowSize',
      errors,
    ),
  };

  return breaker;
}
