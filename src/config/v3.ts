/**
 * Format `arbiter-config-v3`: v2 plus the rule-level `combine` connective.
 *
 * The only difference from v2 is that this format is written by this build, so a
 * document declaring it is held to the strict reading: a rule with several
 * conditions must state `combine`, and an unknown field is an error rather than a
 * warning. That strictness is what makes a misspelled connective impossible to
 * ignore — in v2 the same typo would silently leave the rule on its alternative
 * semantics.
 */

import type {
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
} from '../types.js';
import { finishDocument, parseConfigSections } from './document.js';
import { parseRule } from './rules.js';

export function parseConfigV3(raw: Record<string, unknown>): ConfigParseResult {
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
    const rule = parseRule(value, index, errors, { strict: true, warnings });
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
