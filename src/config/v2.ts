/**
 * Format `arbiter-config-v2`: scope, OR conditions, RFC 9535 JSONPath selectors
 * and whole-value matching.
 *
 * A document that declares `arbiter-config-v1` is converted by `legacy.ts` only
 * where equivalence is provable; a document that declares no format keeps the
 * legacy prefix semantics and never inherits this behaviour silently.
 *
 * `combine` belongs to v3. Accepting it here would be the one thing this module
 * exists to prevent: a reader that ignores the field and evaluates the wider
 * alternative while the author believes they narrowed the rule.
 */

import type {
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
} from '../types.js';
import { finishDocument, parseConfigSections } from './document.js';
import { isRecord } from './values.js';
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
    if (isRecord(value) && value['combine'] !== undefined) {
      errors.push({
        path: `rules[${String(index)}].combine`,
        message:
          '"combine" requires format "arbiter-config-v3"; the v2 format has no connective and would ignore it',
        code: 'rule.format-mismatch',
        params: { format: 'arbiter-config-v3', field: 'combine' },
      });
      return;
    }
    const rule = parseRule(value, index, errors, {
      strict: false,
      warnings,
    });
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
