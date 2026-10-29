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

/**
 * The prefix of the opaque token one verified score object is held as.
 *
 * It starts with NUL, which cannot occur in a provider's JSON text, so a real value
 * can never be mistaken for a token during the masking pass.
 */
const SCORE_TOKEN_PREFIX = '\u0000score:';

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
    // The `{` this member opens: the last character of the match.
    const objectStart = match.index + match[0].length - 1;
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
    // The span is the object itself, so extraction can replace exactly it.
    spans.push([objectStart, index + 1]);
  }
  return spans;
}

export function redactAuthHeaders(text: string): string {
  // Verified score objects are extracted *before* the field pattern runs. The
  // pattern's value branch stops at a quote or a structural terminator, so it
  // cannot carry a whole object; letting it try would rebuild a truncated
  // fragment. Each verified object becomes an opaque token, the remaining text is
  // masked normally, and the rebuilt objects are restored afterwards.
  const { masked, restored } = extractScoreObjects(text);
  // One pass over the field name and separator, then the whole value: a quoted
  // value (JSON double quotes, a JS object dump with single quotes, backticks)
  // or everything up to a structural terminator. The unquoted branch must
  // consume spaces too, because an auth scheme is only the prefix — stopping at
  // the first space would leave the credential itself in place.
  const pattern = new RegExp(
    `((?:"|')?(?:${AUTH_FIELD})(?:"|')?)(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^,;}\\]\\n]+)`,
    'giu',
  );
  const redacted = masked.replace(
    pattern,
    (match: string, field: string, separator: string, value: string) =>
      // A verified score object became a token here; it is already rebuilt and
      // must survive this pass so it can be restored intact. A numeric literal is
      // a chat answer's band. Everything else is masked, which is what keeps a
      // credential-shaped value hidden whatever field carries it.
      value.startsWith(SCORE_TOKEN_PREFIX) || isScoreLiteral(field, value)
        ? match
        : `${field}${separator}[redacted]`,
  );
  return restored.reduce(
    (current, [token, object]) => current.replace(token, object),
    redacted,
  );
}

/**
 * Replace every verified score object with an opaque token.
 *
 * The rebuilt object keeps only the members a score answer may carry; every other
 * member's value becomes `[redacted]`. That is stronger than exempting the span: an
 * exemption preserves whatever travels beside a valid distribution, which is
 * exactly how a forged answer would smuggle a credential past a structural check.
 */
function extractScoreObjects(text: string): {
  readonly masked: string;
  readonly restored: readonly (readonly [string, string])[];
} {
  const restored: (readonly [string, string])[] = [];
  const spans = scoreObjectSpans(text);
  if (spans.length === 0) return { masked: text, restored };
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    const token = `${SCORE_TOKEN_PREFIX}${String(restored.length)}\u0000`;
    restored.push([token, rebuildScoreObject(text.slice(start, end))]);
    out += `${text.slice(cursor, start)}${token}`;
    cursor = end;
  }
  return { masked: out + text.slice(cursor), restored };
}

/**
 * Whether this object's own top-level members identify a score answer.
 *
 * The predicate is deliberately narrow: the object must declare the score type the
 * decision protocol sends. It cannot prove the object is genuine — a forged answer
 * can declare the type too — which is why the exemption does not preserve the span
 * but rebuilds it from the members a score may carry. This test only decides
 * whether the object is a candidate for that rebuild.
 */
function isScoreObject(fragment: string): boolean {
  const body = fragment.slice(1, -1);
  const member = /"type"\s*:\s*"([^"]*)"/u.exec(topLevelMembers(body));
  return member?.[1] === 'score';
}

/**
 * The portion of an object body that belongs to its own members.
 *
 * Nested objects and arrays are collapsed, so a `"type":"score"` inside them cannot
 * satisfy {@link isScoreObject}. Text inside string literals is kept because that is
 * where the member values live.
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
 * The members a decision score answer is allowed to carry.
 *
 * This is the whole list on purpose: the exemption exists so a real answer stays
 * readable, and a real answer has exactly these. Anything else beside them is not
 * part of a score and cannot be trusted to be harmless.
 */
const SCORE_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'probabilities',
  'score',
  'legend',
  'confidence',
]);

/** One member's key and the text before its value, when it has them. */
const MEMBER_PREFIX = /^(\s*"([^"]*)"\s*:\s*)/u;

/**
 * The members whose value must be a plain number.
 *
 * `confidence` is a bare number in the decision protocol. Anything else in that
 * position is not a value this contract reads, so it cannot be retained.
 */
const NUMERIC_MEMBERS: ReadonlySet<string> = new Set(['confidence']);

/** A JSON number, exactly. */
const JSON_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/** A JSON string literal, exactly, including its quotes. */
const JSON_STRING = /^"(?:[^"\\]|\\.)*"$/u;

/**
 * Rebuild a verified score object, keeping only the members a score may carry.
 *
 * Two separate jobs are done here, and skipping either one leaves a hole:
 *
 *   - **membership**: an unrecognized member's value becomes `[redacted]`, so a
 *     forged answer cannot attach a credential beside a valid distribution;
 *   - **content**: a *recognized* member is not automatically safe. `legend`
 *     carries model-written descriptive text, so a provider (or something that
 *     forged the answer) can put `Authorization: Bearer …` inside it. Every
 *     retained value is therefore rescanned with the same authentication-header
 *     rule before it goes back, and a numeric member that is not a number, or a
 *     string member that is not a string, is replaced rather than trusted.
 *
 * The retained value's own masking runs with the object's span already removed
 * from the text, so a credential inside `legend` cannot be protected by the
 * object it is nested in.
 */
function rebuildScoreObject(objectText: string): string {
  const kept: string[] = [];
  // A member may appear once. A second `type` (or a second `probabilities`) is not
  // part of any answer this contract asks for, and restoring one verbatim would put
  // attacker-controlled text back into the record.
  const seen = new Set<string>();
  let typed = false;
  for (const member of topLevelMemberChunks(objectText.slice(1, -1))) {
    const match = MEMBER_PREFIX.exec(member);
    if (match === null) continue;
    const key = match[2] ?? '';
    const prefix = match[1] ?? '';
    const value = member.slice(prefix.length).trim();
    if (!SCORE_MEMBERS.has(key) || seen.has(key)) {
      // The rejected member's *key* is provider-controlled text too. It must go
      // through the header rule rather than being reprinted, or an echo that has
      // been moved from the value into the key would be restored untouched. If the
      // key itself carries a header, the whole member collapses to `[redacted]`
      // because a masked key can no longer name a field.
      const safeKey = maskHeadersIn(prefix);
      kept.push(safeKey === prefix ? `${prefix}[redacted]` : '[redacted]');
      continue;
    }
    seen.add(key);
    if (key === 'type') {
      // The only `type` this contract accepts is its own literal. Anything else —
      // including a second `type` carrying an echo — is not restored; the object
      // simply does not qualify as a score answer.
      if (value !== JSON_SCORE_TYPE) return maskHeadersIn(objectText);
      typed = true;
      kept.push(`${prefix}${JSON_SCORE_TYPE}`);
      continue;
    }
    const shape = retainedShape(key, value);
    kept.push(shape === null ? `${prefix}[redacted]` : `${prefix}${shape}`);
  }
  if (!typed) return maskHeadersIn(objectText);
  // A score object that lost every other member keeps only its verified type.
  return `{${kept.join(',')}}`;
}

/** The one `type` value this contract's score answer carries, with its quotes. */
const JSON_SCORE_TYPE = '"score"';

/**
 * A legitimate level key: the decision protocol numbers criteria 0..9 and the public
 * scale prints 1..10, so both spellings are legal and nothing else is.
 *
 * Restricting the *key* as well as the value is what closes the object-shaped hole:
 * a description can travel in a key as easily as in a value, and the outer masking
 * pass cannot see inside a score object it has already extracted.
 */
const LEVEL_KEY = /^"(?:\d|10)"$/u;

/**
 * The value to retain for one member, or null when it cannot be retained safely.
 *
 * Nothing here restores raw text. A retained fragment is either a JSON number, a
 * verified literal, or an object whose keys are level identifiers and whose values
 * have themselves been checked; free text is passed through the authentication-header
 * rule and dropped when it does not fit the declared shape.
 */
function retainedShape(key: string, value: string): string | null {
  if (NUMERIC_MEMBERS.has(key) || key === 'score') {
    return JSON_NUMBER.test(value) ? value : null;
  }
  if (key === 'probabilities') return levelObject(value, 'number');
  // `legend` is descriptive text, or a map of level to description.
  if (JSON_STRING.test(value)) {
    // A bare description is model-written text: it is scanned, never trusted.
    const masked = maskHeadersIn(value);
    // If scanning changed it, the original carried a header and the masked form is
    // what belongs in the record.
    return masked;
  }
  return levelObject(value, 'text');
}

/**
 * An object keyed by level identifier, with every value of the declared kind.
 *
 * Keys are only kept when they are a legal level; a key is text the provider chose,
 * so it is subject to the same rule as a value.
 */
function levelObject(value: string, kind: 'number' | 'text'): string | null {
  if (!value.startsWith('{')) return null;
  const kept: string[] = [];
  for (const entry of topLevelMemberChunks(value.slice(1, -1))) {
    const match = MEMBER_PREFIX.exec(entry);
    // A key is provider-chosen text: it must be a legal level *and* carry no
    // header. Either failure rejects the whole object, which then falls back to
    // being scanned as ordinary text.
    if (match === null) return null;
    const rawKey = match[1] ?? '';
    if (!LEVEL_KEY.test(`"${match[2] ?? ''}"`)) return null;
    if (maskHeadersIn(rawKey) !== rawKey) return null;
    const prefix = match[1] ?? '';
    const inner = entry.slice(prefix.length).trim();
    if (kind === 'number') {
      if (!JSON_NUMBER.test(inner)) return null;
      kept.push(`${prefix}${inner}`);
      continue;
    }
    if (!JSON_STRING.test(inner)) return null;
    kept.push(`${prefix}${maskHeadersIn(inner)}`);
  }
  return `{${kept.join(',')}}`;
}

/**
 * Apply the authentication-header rule to a retained fragment.
 *
 * This is the same rule the whole document goes through; running it here as well is
 * what stops a value that was protected from the outer pass by its enclosing object
 * from being restored unscanned.
 */
function maskHeadersIn(fragment: string): string {
  const pattern = new RegExp(
    `((?:"|')?(?:${AUTH_FIELD})(?:"|')?)(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^,;}\\]\\n]+)`,
    'giu',
  );
  return fragment.replace(
    pattern,
    (match: string, field: string, separator: string, value: string) =>
      isScoreLiteral(field, value) ? match : `${field}${separator}[redacted]`,
  );
}

/**
 * The top-level member chunks of an object body.
 *
 * Splitting respects nested braces, brackets and string literals, so a comma inside
 * `probabilities` or inside a legend string does not split a member.
 */
function topLevelMemberChunks(body: string): readonly string[] {
  const chunks: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
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
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      chunks.push(body.slice(start, index));
      start = index + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim().length > 0) chunks.push(tail);
  return chunks;
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
