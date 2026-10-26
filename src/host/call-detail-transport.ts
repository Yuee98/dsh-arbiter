/**
 * Keeping Reviewer *transport* material out of the detail.
 *
 * The audit already excludes transport credentials at the producer: a decision
 * attempt stores the request body, never its `headers`, and the credential value
 * is only ever substituted into that header at send time. This module enforces
 * the same boundary on the read path as defence in depth — and only that
 * boundary.
 *
 * It deliberately does not look for "secrets" in content. Tool arguments, the
 * snapshot, model responses and configuration are original evidence: the design
 * requires them to be shown exactly as stored, because a reader has to be able to
 * see which command was actually evaluated. Masking a token a user typed into a
 * command would rewrite the evidence this view exists to preserve.
 */

/** Header names that carry Reviewer transport authentication. */
const TRANSPORT_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'apikey',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One model attempt's request, minus its transport block.
 *
 * Only a top-level `headers` object is removed, and only its auth entries are
 * dropped: that object is transport metadata, not part of the reviewed content.
 * Every other field is returned as stored.
 */
export function reviewedRequest(request: unknown): unknown {
  if (!isRecord(request)) return request;
  const headers = request['headers'];
  if (!isRecord(headers)) return request;
  const kept = Object.entries(headers).filter(
    ([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()),
  );
  return {
    ...request,
    headers: Object.fromEntries(kept),
  };
}
