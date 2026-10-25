/**
 * Format `arbiter-config-v1`: the legacy single-condition rule model.
 *
 * The format keeps its documented prefix semantics: rules are converted to the
 * canonical model only where equivalence is provable, and a rule that cannot be
 * converted is a blocking error. The original document is never rewritten, and
 * the host keeps its previous effective configuration when this format rejects a
 * candidate.
 *
 * A canonical rule is **not** accepted here. Allowing it would let an undeclared
 * or v1-declared document acquire the canonical matching semantics, which is
 * exactly what the explicit format registry exists to prevent; such a document
 * must declare `arbiter-config-v2`.
 */

import type {
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
} from '../types.js';
import { finishDocument, parseConfigSections } from './document.js';
import { canonicalKeyUsed, convertLegacyRule } from './legacy.js';

/** Validate a v1 document; unlisted invalid fields keep their default value. */
export function parseConfigV1(raw: Record<string, unknown>): ConfigParseResult {
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
    const canonicalKey = canonicalKeyUsed(value);
    if (canonicalKey !== null) {
      errors.push({
        path: `rules[${String(index)}]`,
        message: `"${canonicalKey}" requires format "arbiter-config-v2"; the legacy format only accepts a single "match" object`,
        code: 'rule.format-mismatch',
        params: { format: 'arbiter-config-v2', field: canonicalKey },
      });
      return;
    }
    const rule = convertLegacyRule(value, index, errors);
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
