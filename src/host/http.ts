import { parseConfig } from '../config.js';
import { CONFIG_FORMAT_V2 } from '../config/format.js';
import type { CommandRule, ConfigError } from '../types.js';

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function readJsonBody(request: Request): Promise<unknown> {
  return request
    .text()
    .then((text) =>
      text.trim().length === 0 ? {} : (JSON.parse(text) as unknown),
    );
}

export interface RuleDraftResult {
  readonly rules: readonly CommandRule[];
  readonly errors: readonly ConfigError[];
}

/**
 * Validate draft rules submitted to the rule tester.
 *
 * A draft is canonical by definition, so it is declared as the canonical format
 * instead of being parsed as an undeclared (legacy) document. Parsing it as
 * legacy would silently drop every draft rule that uses the new model and let the
 * tester fall back to the effective configuration — exactly the disagreement
 * between the tester and the real gate this issue has to remove.
 *
 * An invalid draft is reported with its concrete errors rather than filtered:
 * silently testing fewer rules than the user asked for would be worse than a
 * visible failure.
 */
export function asRuleDraft(value: unknown): RuleDraftResult {
  const parsed = parseConfig({ format: CONFIG_FORMAT_V2, rules: [value] });
  return {
    rules: parsed.errors.length > 0 ? [] : parsed.config.rules,
    errors: parsed.errors,
  };
}
