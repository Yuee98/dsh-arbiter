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
import { parseConfigV2 } from './config/v2.js';
import { parseConfigV3 } from './config/v3.js';
import {
  CONFIG_FORMAT_FIELD,
  CONFIG_FORMAT_V1,
  CONFIG_FORMAT_V2,
  CONFIG_FORMAT_V3,
  identifyConfigFormat,
  registerConfigFormat,
} from './config/format.js';
export { DEFAULT_CONFIG } from './config/defaults.js';
export {
  registerConfigFormat,
  registeredConfigFormats,
} from './config/format.js';

registerConfigFormat({
  id: CONFIG_FORMAT_V1,
  legacy: true,
  parse: parseConfigV1,
});

registerConfigFormat({
  id: CONFIG_FORMAT_V2,
  parse: parseConfigV2,
});

registerConfigFormat({
  id: CONFIG_FORMAT_V3,
  parse: parseConfigV3,
});

/**
 * Validate a configuration document that must exist.
 *
 * A missing or non-object value is an error here: only the host's first-install
 * boundary may turn absence into defaults. That keeps a malformed HTTP body or
 * an unreadable document from being accepted as "the default configuration".
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  if (!isRecord(raw)) {
    return {
      config: DEFAULT_CONFIG,
      errors: [
        {
          path: '',
          message: 'configuration must be an object',
          code: 'config.not-object',
        },
      ],
      warnings: [],
    };
  }
  return parseDocumentRecord(raw);
}

/**
 * Validate the profile document, where absence means first install.
 *
 * The confirmed defaults are the first-release behavior for a profile that has
 * no user configuration yet; an existing document is never overwritten by them.
 */
export function parseDocument(raw: unknown): ConfigParseResult {
  if (raw === undefined || raw === null)
    return { config: DEFAULT_CONFIG, errors: [], warnings: [] };
  return parseConfig(raw);
}

function parseDocumentRecord(raw: Record<string, unknown>): ConfigParseResult {
  const format = identifyConfigFormat(raw);
  if (format.handler === null) {
    return {
      config: DEFAULT_CONFIG,
      errors: [
        {
          path: CONFIG_FORMAT_FIELD,
          message: format.error ?? 'configuration format is invalid',
          code: format.code ?? 'config.format',
        },
      ],
      warnings: [],
    };
  }

  const parsed = format.handler.parse(raw);
  // Keep an explicit declaration in the normalized content so content identity
  // distinguishes a declared format from the implicit legacy document, and a
  // UI save round-trips the same declaration instead of dropping it.
  const config: ArbiterConfig =
    format.explicit && format.id !== null
      ? { ...parsed.config, format: format.id }
      : parsed.config;
  const warnings: ConfigWarning[] = [...parsed.warnings];
  if (!format.explicit && config.rules.length > 0) {
    warnings.push({
      path: CONFIG_FORMAT_FIELD,
      message: `no "${CONFIG_FORMAT_FIELD}" is declared; legacy rules keep the prefix semantics of "${format.handler.id}" and are converted only where equivalence is provable`,
      code: 'config.format-implicit',
      params: { format: format.handler.id },
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

/**
 * The ask policy one session class uses.
 *
 * The two session classes keep their own setting; a subagent does not inherit the
 * main session's mode, because whether the host can reach a person is a property of
 * the session, not of its parent. `no-ask` is still only a statement about
 * questions: the same matrix decides the score either way.
 */
export function askPolicyForSession(
  config: ArbiterConfig,
  sessionKind: 'main' | 'subagent',
): ApprovalMode {
  return sessionKind === 'main' ? config.modes.main : config.modes.subagent;
}
