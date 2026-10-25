/**
 * Format `arbiter-config-v2`: scope, OR conditions, RFC 9535 JSONPath selectors
 * and whole-value matching.
 *
 * This is the current model. A document that declares `arbiter-config-v1` is
 * converted by `legacy.ts` only where equivalence is provable; a document that
 * declares no format keeps the legacy prefix semantics and never inherits this
 * behaviour silently.
 */

import type {
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
} from '../types.js';
import { finishDocument, parseConfigSections } from './document.js';
import { parseRule } from './rules.js';

export function parseConfigV2(raw: Record<string, unknown>): ConfigParseResult {
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
  return {
    config: finishDocument(sections, rules, errors, warnings, sourceIndices),
    errors,
    warnings,
  };
}
