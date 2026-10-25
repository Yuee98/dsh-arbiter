/**
 * Configuration shape, defaults, validation and normalization.
 *
 * The profile patch is the single editable source of truth. This module only
 * projects it into a complete effective configuration and reports errors; the
 * host keeps the last effective configuration when a candidate is invalid.
 *
 * Documents may declare `format`. Identification is explicit and shared by the
 * UI save path and external file replacement; an unknown format is an error
 * rather than a silent reinterpretation with newer matching semantics.
 */

import type {
  ArbiterConfig,
  ApprovalMode,
  ConfigParseResult,
  ConfigWarning,
} from './types.js';
import { DEFAULT_CONFIG } from './config/defaults.js';
import { isRecord } from './config/values.js';
import { parseConfigV1 } from './config/v1.js';
import {
  CONFIG_FORMAT_FIELD,
  DEFAULT_CONFIG_FORMAT,
  identifyConfigFormat,
  registerConfigFormat,
} from './config/format.js';
export { DEFAULT_CONFIG } from './config/defaults.js';
export {
  registerConfigFormat,
  registeredConfigFormats,
} from './config/format.js';

registerConfigFormat({
  id: DEFAULT_CONFIG_FORMAT,
  legacy: true,
  parse: parseConfigV1,
});

function firstInstall(raw: unknown): boolean {
  return raw === undefined || raw === null;
}

/**
 * Validate and normalize an arbitrary configuration value.
 *
 * A missing document means a first install and yields the confirmed defaults.
 * Invalid fields keep their default value and are reported; the caller decides
 * whether to apply the candidate. Invalid individual rules are dropped only
 * after being reported, so a typo never silently becomes an allow.
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  if (firstInstall(raw))
    return { config: DEFAULT_CONFIG, errors: [], warnings: [] };
  if (!isRecord(raw)) {
    return {
      config: DEFAULT_CONFIG,
      errors: [{ path: '', message: 'configuration must be an object' }],
      warnings: [],
    };
  }

  const format = identifyConfigFormat(raw);
  if (format.handler === null) {
    return {
      config: DEFAULT_CONFIG,
      errors: [
        {
          path: CONFIG_FORMAT_FIELD,
          message: format.error ?? 'configuration format is invalid',
        },
      ],
      warnings: [],
    };
  }

  const parsed = format.handler.parse(raw);
  // Keep an explicit declaration in the normalized content so content identity
  // distinguishes a declared format from the implicit legacy one.
  const config =
    format.explicit && format.id !== null
      ? { ...parsed.config, format: format.id }
      : parsed.config;
  const warnings: ConfigWarning[] = [...parsed.warnings];
  if (!format.explicit && config.rules.length > 0) {
    warnings.push({
      path: CONFIG_FORMAT_FIELD,
      message: `no "${CONFIG_FORMAT_FIELD}" is declared; rules use the legacy prefix semantics of "${format.handler.id}"`,
    });
  }
  return {
    config,
    errors: parsed.errors,
    warnings,
  };
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
