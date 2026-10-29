/**
 * The decision transport's mechanics, shared by both reviewer paths.
 *
 * These are the parts that belong to the *endpoint* rather than to the answer
 * contract: which envelope a URL expects, where a provider puts its explanation,
 * how a failure string is spelled, and which payload a usage report is read
 * from. Two copies of this would drift in a way that is invisible until a
 * provider updates one of the three entries, so it is written once here and the
 * adapters call it.
 */

import { redact, redactValue } from './redact.js';

/** How a decision endpoint wants its request body wrapped. */
export type RequestShape = 'flat' | 'wrapped';

/**
 * The request envelope this endpoint expects.
 *
 * The two vendors agree on the question/answer vocabulary but not on the HTTP
 * body. The distinction is a property of the *entry point*, not of the vendor:
 *
 *   POST /accounts/{acct}/ai/run/@cf/cloudflare/{model}   flat   {model,state,questions}
 *   POST /accounts/{acct}/ai/run                          wrapped {model,input:{state,questions}}
 *   POST https://api.typesafe.ai/v1/systemone             flat   {model,state,questions}
 *
 * The generic Cloudflare entry is the only wrapped one, and its pathname ends in
 * `/ai/run`. Every other path keeps the flat body — including an endpoint this
 * plugin has never seen, because a custom compatible service was addressable
 * before and must stay addressable. A URL that cannot be parsed also stays flat:
 * guessing a wrapper from an unknown string would change the request without
 * evidence.
 */
export function requestShapeOf(url: string): RequestShape {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'flat';
  }
  return /\/ai\/run\/?$/u.test(pathname) ? 'wrapped' : 'flat';
}

/** The longest provider explanation kept in a record. */
const MAX_EXPLANATION = 300;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * The explanation a provider supplied, if it supplied one.
 *
 * The three documented shapes are Cloudflare's `errors[].message`, a plain
 * `error.message`, and TypeSafe's `detail.message`. Only those fields are read:
 * a failure must never carry request state, tool output, file content, or the
 * whole body into a record that is shown to a person and stored.
 */
export function providerExplanation(parsed: unknown): string | null {
  if (!record(parsed)) return null;
  const errors = parsed['errors'];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const message = record(entry) ? text(entry['message']) : null;
      if (message !== null) return message;
    }
  }
  for (const key of ['error', 'detail'] as const) {
    const nested = parsed[key];
    const message = record(nested) ? text(nested['message']) : null;
    if (message !== null) return message;
    const direct = text(nested);
    if (direct !== null) return direct;
  }
  return null;
}

/**
 * The one error string this attempt reports, in both places it is consumed.
 *
 * `HTTP <status>` stays the exact prefix: the connection test classifies a
 * failure by matching it, and a rewritten prefix would turn an authentication
 * failure into an unclassified one. The explanation follows the prefix, so an
 * explanation is additive rather than a replacement.
 */
export function failureText(
  status: number,
  explanation: string | null,
  secrets: readonly string[],
): string {
  const base = `HTTP ${String(status)}`;
  if (explanation === null) return base;
  // Mask before bounding: truncating first can cut a credential in half, and a
  // half is no longer an exact-value match, so the visible prefix would survive
  // the mask that was supposed to remove it.
  const masked = redact(explanation, secrets);
  const bounded =
    masked.length > MAX_EXPLANATION
      ? `${masked.slice(0, MAX_EXPLANATION)}…`
      : masked;
  return `${base}: ${bounded}`;
}

/**
 * The `usage` a provider reported, masked before it can be stored.
 *
 * Usage is read whether or not the response produced a verdict: a provider that
 * reports a failure was still billed for the request, and that is exactly when
 * the caller most wants the count. Cloudflare nests the payload under `result`,
 * a native endpoint answers at the root, and both put `usage` beside `answers`.
 */
export function reportedUsage(
  parsed: unknown,
  secrets: readonly string[],
): unknown {
  if (!record(parsed)) return null;
  const payload = record(parsed['result']) ? parsed['result'] : parsed;
  const usage = payload['usage'];
  if (usage === undefined) return null;
  return redactValue(usage, secrets);
}

/**
 * The `answers` object a decision response carries, if it carries one.
 *
 * Two placements exist among the supported endpoints, and they belong to
 * different envelopes rather than being alternatives for one vendor:
 *
 *   Cloudflare edge   { result: { model, answers, usage }, success, errors, messages }
 *   native endpoints  { model, answers, usage }
 *
 * The object is taken whole rather than unpacked here so the caller can also
 * read the sibling `usage` from the same payload. There is no `result.response`
 * fallback: no documented endpoint produces that key.
 */
export function decisionAnswers(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const nested = body['result'];
  const fromResult =
    record(nested) && record(nested['answers']) ? nested['answers'] : undefined;
  if (fromResult !== undefined) return fromResult;
  return record(body['answers']) ? body['answers'] : undefined;
}
