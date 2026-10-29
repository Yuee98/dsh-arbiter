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
  'authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|apikey|api_key|access_token|refresh_token';

/**
 * The exact spelling of this contract's authorization score member.
 *
 * `authorization` names both an HTTP header and one of the two public bands, and
 * the two spellings are distinguishable: the score member appears in a JSON object
 * as a lowercase, double-quoted key, while a header is written bare
 * (`Authorization: …`, `authorization=…`) or with its own capitalized name. So the
 * exemption requires this exact spelling, case included — a bare or capitalized
 * `Authorization` is a header whatever its value looks like.
 */
const SCORE_FIELD = /^"authorization"$/u;

/** A JSON numeric literal, unquoted. */
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * The spans where `"authorization"` holds the answer's score *object*.
 *
 * The decision protocol answers `{"authorization": {"type":"score",
 * "probabilities":{…}}}`, so the member's value is an object, not a number. A
 * regex cannot match a balanced object, and the generic unquoted branch stops at
 * the first `,` or `}` — masking that fragment would leave the rest of the object
 * behind and produce invalid JSON. The spans are therefore located by counting
 * braces (respecting JSON string literals).
 *
 * **Being a balanced object is not enough.** An exemption keyed on shape alone
 * would excuse any object at this key, and an object is the obvious way to smuggle
 * a credential past a matcher that only rescans auth-named fields:
 * `{"authorization":{"value":"Bearer …"}}` is not a score, yet it satisfies
 * "balanced object after the exact key". So a span counts only when its own
 * top-level members identify a score answer — the same `"type":"score"` the
 * decision protocol sends. Anything else is ordinary text to the masker.
 *
 * Skipping is scoped to that verified span, so a bare or capitalized header inside
 * the same object is still masked: only the score member is exempt, not its
 * contents.
 */
function scoreObjectSpans(
  text: string,
): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  const opener = /"authorization"\s*:\s*\{/gu;
  for (
    let match = opener.exec(text);
    match !== null;
    match = opener.exec(text)
  ) {
    const start = match.index;
    // The `{` this member opens: the last character of the match. The span keeps
    // the key so `isScoreMember` can compare offsets against the match start, and
    // the object itself starts one character later.
    const objectStart = start + match[0].length - 1;
    let depth = 0;
    let index = objectStart;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // An unterminated object is not a span: the text is truncated, and guessing
    // where it ends is how a masker would drop its own protection.
    if (depth !== 0) continue;
    // Only a structurally verified score answer is exempt. The check reads the
    // object's own text, so an object that merely sits at this key is still masked.
    if (!isScoreObject(text.slice(objectStart, index + 1))) continue;
    spans.push([start, index + 1]);
  }
  return spans;
}

export function redactAuthHeaders(text: string): string {
  // The spans are found first, from the original text, so the exemption is decided
  // by evidence gathered before any masking can move an offset.
  const spans = scoreObjectSpans(text);
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
    (
      match: string,
      field: string,
      separator: string,
      value: string,
      offset: number,
    ) => {
      // The exemption is the answer's own member, not a safe region: the object it
      // opens is rescanned without the exemption, so a credential placed inside the
      // answer is still masked even though that mask makes the object unparseable.
      // Masking wins over parseability when the two conflict.
      if (isScoreMember(spans, field, value, offset))
        return `${field}${separator}${maskStrict(value, pattern)}`;
      // A numeric literal is a chat answer's band. Everything else is masked, which
      // is what keeps a credential-shaped value hidden whatever field carries it.
      return isScoreLiteral(field, value)
        ? match
        : `${field}${separator}[redacted]`;
    },
  );
}

/** Mask every auth-looking field in a fragment, exempting nothing. */
function maskStrict(fragment: string, pattern: RegExp): string {
  return fragment.replace(
    pattern,
    (_match: string, field: string, separator: string) =>
      `${field}${separator}[redacted]`,
  );
}

/**
 * Whether this object's own top-level members identify a score answer.
 *
 * The predicate is deliberately narrow: the object must declare the score type the
 * decision protocol sends. It does not need to validate the distribution — the
 * parser does that, and this module is not a parser — but it must be impossible for
 * an arbitrary object carrying a credential to satisfy it. A `"type"` value that is
 * not `"score"`, a missing `"type"`, or a nested `"type":"score"` (which is not a
 * top-level member) all fail.
 */
function isScoreObject(fragment: string): boolean {
  // The opening brace is part of the span; the members start after it.
  const body = fragment.slice(1, -1);
  const member = /"type"\s*:\s*"([^"]*)"/u.exec(topLevelMembers(body));
  return member?.[1] === 'score';
}

/**
 * The portion of an object body that belongs to its own members.
 *
 * Nested objects are replaced by a placeholder, so a `"type":"score"` inside a
 * nested array or object cannot satisfy {@link isScoreObject}. Text inside string
 * literals is kept because that is where the member values live.
 */
function topLevelMembers(body: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      if (depth === 0) out += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      if (depth === 0) out += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      if (depth === 0) out += character;
      continue;
    }
    if (!inString) {
      if (character === '{' || character === '[') {
        depth += 1;
        if (depth === 1) out += ' ';
        continue;
      }
      if (character === '}' || character === ']') {
        depth -= 1;
        continue;
      }
    }
    if (depth === 0) out += character;
  }
  return out;
}

/**
 * Whether this match is the score object's own opening member.
 *
 * Three conditions together, and each rules out a way to over-exempt: the exact
 * JSON spelling of the key, a value that opens an object (not a quoted string), and
 * an offset that is exactly where a balanced score-member span begins.
 */
function isScoreMember(
  spans: readonly (readonly [number, number])[],
  field: string,
  value: string,
  offset: number,
): boolean {
  if (!SCORE_FIELD.test(field.trim())) return false;
  if (!value.trimStart().startsWith('{')) return false;
  return spans.some(([start]) => start === offset);
}

/**
 * Whether this field/value pair is the public authorization score.
 *
 * Both conditions are narrow on purpose: the key must be the exact JSON spelling
 * this contract's answer uses, and the value must be an unquoted number. Every
 * other auth-looking field masks whatever it holds, including a numeric-only
 * value, because a host-owned chat credential has no value available to match and
 * the structural pass is the only thing standing between it and the record.
 */
function isScoreLiteral(field: string, value: string): boolean {
  return SCORE_FIELD.test(field.trim()) && NUMERIC_LITERAL.test(value.trim());
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
