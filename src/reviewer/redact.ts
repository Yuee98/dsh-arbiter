/**
 * Masking of externally derived text and values.
 *
 * This is a leaf module on purpose. Both the decision adapter and the
 * diagnostic probe need the same rule, and the probe imports the adapter, so a
 * shared home is the only way to have one rule without a runtime import cycle.
 *
 * The rule is deliberately narrow: replace a value the caller already knows
 * (the credential it sent) and the shape of an authentication header. It is not
 * a general secret scanner and must not become one — guessing at secrets would
 * either miss the real one or mangle ordinary content.
 */

/** Replace every occurrence of a known secret, so no echo can carry it out. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (current, secret) =>
      secret.length === 0 ? current : current.split(secret).join('[redacted]'),
    text,
  );
}

/**
 * Mask an authentication header wherever it appears in free text.
 *
 * A provider that echoes `Authorization: Bearer …` — in plain text, in a JSON
 * body, or in a JavaScript object-inspection dump — would otherwise publish a
 * credential it received. For chat the probe has no value to match, because the
 * host's LLM service owns the credential, so masking the field shape covers
 * that path without guessing what the secret is.
 *
 * The value is matched as a whole token rather than up to the first space: with
 * a `Bearer`/`Basic`/… scheme, the scheme is part of the value, so stopping at
 * the space would leave the credential itself behind.
 */
const AUTH_FIELD =
  'authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|apikey|access_token|refresh_token';

/**
 * The one field whose numeric value is a score, not a credential.
 *
 * `authorization` names both an HTTP header and one of this contract's two public
 * bands, so `{"authorization":8}` is an ordinary reviewer answer and masking it
 * corrupts every stored attempt. The exemption is therefore scoped to this exact
 * field name in exactly that form, rather than to numeric values under any
 * authentication-looking key: `X-Api-Key: 123456789` is still a credential and
 * still masks.
 */
const SCORE_FIELD = /^(?:"|')?authorization(?:"|')?$/iu;

/** A JSON literal: a number, boolean or null. */
const LITERAL_VALUE = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/u;

/** A JSON string holding only digits, which may be a numeric credential. */
const QUOTED_LITERAL = /^(?:"|')?(-?\d+(?:\.\d+)?)(?:"|')?$/u;

export function redactAuthHeaders(text: string): string {
  // One pass over the field name and separator, then the whole value: a quoted
  // value (JSON double quotes, a JS object dump with single quotes, backticks)
  // or everything up to a structural terminator. The unquoted branch must
  // consume spaces too, because an auth scheme is only the prefix — stopping at
  // the first space would leave the credential itself in place.
  const pattern = new RegExp(
    `((?:"|')?(?:${AUTH_FIELD})(?:"|')?)(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^,;}\\]\\n]+)`,
    'giu',
  );
  return text.replace(
    pattern,
    (match: string, field: string, separator: string, value: string) =>
      isScoreLiteral(field, value) ? match : `${field}${separator}[redacted]`,
  );
}

/**
 * Whether this field/value pair is a public score rather than a credential.
 *
 * Two conditions together, not either: the field must be exactly `authorization`,
 * and the value must be a bare number. A quoted or unquoted string — including one
 * that happens to be all digits — still masks, because a header value is
 * arbitrary text and only the score member is known to be numeric.
 */
function isScoreLiteral(field: string, value: string): boolean {
  if (!SCORE_FIELD.test(field.trim())) return false;
  // A quoted value is a string; only an unquoted numeric literal is the score.
  if (/^["'`]/u.test(value.trim())) return false;
  return LITERAL_VALUE.test(value.trim()) && !QUOTED_LITERAL.test(field);
}

/**
 * Mask known secrets and recognisable auth headers in an arbitrary value.
 *
 * Keys are masked as well as values. A provider-supplied object is arbitrary
 * text on both sides of the colon: a `usage` payload keyed by the credential
 * would carry it into the audit row even after every value had been cleaned.
 * Two keys that mask to the same text collapse into one, which is acceptable
 * because the sensitive content is gone and the remaining number is still
 * readable — losing a redacted duplicate is cheaper than keeping a secret.
 */
export function redactValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string')
    return redact(redactAuthHeaders(value), secrets);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => redactValue(item, secrets, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(redactAuthHeaders(key), secrets),
        redactValue(item, secrets, seen),
      ]),
    );
  }
  return value;
}
