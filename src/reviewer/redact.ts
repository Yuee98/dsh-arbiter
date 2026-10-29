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

export function redactAuthHeaders(text: string): string {
  // One pass over the field name and separator, then the whole value: a quoted
  // value (JSON double quotes, a JS object dump with single quotes, backticks)
  // or everything up to a structural terminator. The unquoted branch must
  // consume spaces too, because an auth scheme is only the prefix — stopping at
  // the first space would leave the credential itself in place.
  const pattern = new RegExp(
    `((?:"|')?(?:${AUTH_FIELD})(?:"|')?\\s*[:=]\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^,;}\\]\\n]+)`,
    'giu',
  );
  return text.replace(pattern, (match: string, prefix: string, value: string) =>
    // A number, boolean or null is not a credential, and masking one destroys a
    // legitimate value. `authorization` is also the name of one of this
    // contract's two scores, so `{"authorization":8}` is an ordinary answer and
    // must survive; a bare quoted or unquoted token still masks, which is what
    // every authentication header shape is. A one-time secret that happens to be
    // all digits is still caught by the known-secret pass that runs beside this
    // one, so narrowing here loses no coverage that pass does not restore.
    LITERAL_VALUE.test(value) ? match : `${prefix}[redacted]`,
  );
}

/** A JSON literal that cannot be a credential: numbers, booleans, null. */
const LITERAL_VALUE = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/u;

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
