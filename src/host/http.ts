import { parseConfig } from '../config.js';
import { CONFIG_FORMAT_V3 } from '../config/format.js';
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
 * Validate the draft rules submitted to the rule tester.
 *
 * The whole array is parsed once, as one canonical document, because rule errors
 * are not always local: a duplicate id is only visible across rules, and the
 * reported path (`rules[N]...`) must be the rule's real position. Parsing each
 * rule in isolation would both miss that conflict and renumber every later rule
 * to index 0, so the page would point at the wrong condition.
 *
 * A draft is declared as the current format rather than submitted without one.
 * Both are read the same way now, but the declaration keeps the request explicit:
 * the tester must validate the draft with the rule model the gate will apply, and
 * an explicit document cannot be mistaken for a file written by another build.
 *
 * An invalid draft is reported with its concrete errors rather than filtered:
 * silently testing fewer rules than the user asked for would be worse than a
 * visible failure.
 */
export function asRuleDraft(value: unknown): RuleDraftResult {
  // A supplied but non-array `rules` is a malformed request, not a draft with no
  // rules: falling back to the effective rules would test a configuration the
  // user never submitted.
  if (!Array.isArray(value)) {
    return {
      rules: [],
      errors: [
        {
          path: 'rules',
          message: 'must be an array',
          code: 'type.array',
        },
      ],
    };
  }
  // The tester must validate the draft with the format this build writes, or a
  // rule carrying `combine` would be rejected as a format mismatch and the
  // panel would disagree with the gate that actually evaluates it.
  const parsed = parseConfig({
    format: CONFIG_FORMAT_V3,
    rules: value,
  });
  return {
    rules: parsed.errors.length > 0 ? [] : parsed.config.rules,
    errors: parsed.errors,
  };
}
