/**
 * Credential removal for the call-detail read path.
 *
 * The detail view is the one place that shows stored request material, so it is
 * also the last place that could publish an authentication header. Two rules:
 *
 *   - an object field named like an auth field is replaced wholesale, whatever
 *     its value, because the field name is the contract rather than a guess at
 *     the secret;
 *   - free text that spells an auth field or a bearer/basic scheme is masked, so
 *     a provider error that echoes the header cannot carry it out.
 *
 * Nothing here guesses secret *values*: the read path does not resolve
 * credentials, so it has no value to search for. Masking the field shape is what
 * makes that possible without storing the secret anywhere new.
 */

const AUTH_FIELD = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'cookie',
  'set-cookie',
]);

const AUTH_FIELDS =
  'authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|apikey|api_key|access_token|refresh_token|cookie|set-cookie';

/**
 * A header assignment inside free text.
 *
 * The whole value is consumed — a scheme such as `Bearer` is only the prefix, so
 * stopping at the first space would leave the credential itself in place.
 */
const AUTH_TEXT = new RegExp(
  `((?:"|')?(?:${AUTH_FIELDS})(?:"|')?\\s*[:=]\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^,;}\\]\\n]+)`,
  'giu',
);

/** A scheme-prefixed token with no field name in front of it. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/giu;

/** Mask any auth field assignment or scheme token in one string. */
export function scrubText(text: string): string {
  return text
    .replace(AUTH_TEXT, (_match, prefix: string) => `${prefix}[redacted]`)
    .replace(AUTH_SCHEME, '$1 [redacted]');
}

/** Deep-copy an arbitrary stored value with credentials masked. */
export function scrubValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => scrubValue(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        AUTH_FIELD.has(key.toLowerCase())
          ? '[redacted]'
          : scrubValue(item, seen),
      ]),
    );
  }
  return value;
}
