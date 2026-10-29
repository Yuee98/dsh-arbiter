import type {
  ArbiterConfig,
  ApprovalMode,
  AuditConfig,
  BreakerConfig,
  BreakerPreset,
  ConfigError,
} from '../types.js';
import { asObject, asEnum, asBoolean, asInteger } from './values.js';

/** The only two modes. Both apply the same matrix. */
const MODES: readonly ApprovalMode[] = ['ask', 'no-ask'];

/**
 * The retired mode names.
 *
 * They are a closed set so the refusal can name them: an unknown string is still a
 * typo, and only a value this build once implemented earns the longer explanation.
 */
const RETIRED_MODES: ReadonlySet<unknown> = new Set([
  'normal',
  'strict',
  'progress',
]);

/**
 * The two modes, parsed strictly.
 *
 * The retired values are named in the refusal rather than left to a generic
 * "must be one of": an operator upgrading from `normal`/`strict`/`progress` should
 * learn that the setting changed meaning, not that their document has a typo.
 * Nothing is converted, because `progress` widened the matrix — a behavior the
 * shared contract no longer has — and `normal`/`strict` were one engine plus a
 * channel switch, which is exactly what `ask`/`no-ask` now states.
 */
/** A retired mode name, for the error's own interpolation. */
function retiredValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseMode(
  value: unknown,
  fallback: ApprovalMode,
  path: string,
  errors: ConfigError[],
): ApprovalMode {
  const parsed = asEnum<ApprovalMode>(value, MODES, fallback, path, errors);
  if (value === undefined || parsed === value) return parsed;
  // `asEnum` already recorded that the value is not one of the two modes; replace
  // that entry with one that names the retired vocabulary, because the generic
  // message would send an upgrading operator looking for a typo.
  const index = errors.findIndex((error) => error.path === path);
  if (index >= 0 && RETIRED_MODES.has(value)) {
    errors[index] = {
      path,
      message:
        'normal, strict and progress were retired; use "ask" or "no-ask" (the shared matrix applies to both, and no-ask only removes the human question)',
      code: 'modes.retired',
      params: { value: retiredValue(value) },
    };
  }
  return parsed;
}

export function parseModes(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ArbiterConfig['modes'] {
  const modesValue = asObject(raw['modes'], 'modes', errors);
  return {
    main: parseMode(modesValue['main'], 'ask', 'modes.main', errors),
    subagent: parseMode(
      modesValue['subagent'],
      'no-ask',
      'modes.subagent',
      errors,
    ),
  };
}

export function parseAudit(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): AuditConfig {
  const auditValue = asObject(raw['audit'], 'audit', errors);
  const audit: AuditConfig = {
    enabled: asBoolean(auditValue['enabled'], true, 'audit.enabled', errors),
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
  const breakerValue = asObject(raw['breaker'], 'breaker', errors);
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
