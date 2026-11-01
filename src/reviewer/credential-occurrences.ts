/** One occurrence rule for raw text, decoded literals and source continuations. */
import { authenticationCredentialSpans } from './credential-auth.js';
import {
  credentialKind,
  explicitCredentialSpans,
} from './credential-fields.js';
import {
  cookieFieldKind,
  cookieHeaderSpans,
  cookieSourceParts,
  type CookieFieldKind,
} from './credential-cookies.js';
import {
  CREDENTIAL_MARKER_SOURCE,
  verifiedCredentialMarker,
} from './credential-markers.js';
import type { CredentialSpan } from './credential-literals.js';
import type { CredentialValueSpan } from './credential-syntax.js';

export interface KnownCredential {
  readonly value: string;
  readonly marker: string;
}

function cookieValues(
  text: string,
  kind: CookieFieldKind,
  offset = 0,
): CredentialValueSpan[] {
  return cookieSourceParts(text, kind, offset)
    .filter((part) => !part.attribute)
    .map((part) => {
      let { valueStart: start, valueEnd: end } = part;
      if (text[start - offset] === '"') {
        start += 1;
        if (text[end - offset - 1] === '"') end -= 1;
      }
      return { start, end, kind: 'cookie' };
    });
}

function valueSpans(text: string, field: string): CredentialValueSpan[] {
  const spans = [
    ...explicitCredentialSpans(text),
    ...authenticationCredentialSpans(text),
  ];
  const values = spans.flatMap((span) =>
    cookieFieldKind(span.kind) !== null
      ? cookieValues(
          text.slice(span.start, span.end),
          cookieFieldKind(span.kind) ?? 'cookie',
          span.start,
        )
      : [payloadSpan(text, span)],
  );
  const cookie = cookieFieldKind(field);
  if (cookie !== null) values.push(...cookieValues(text, cookie));
  else if (field.length > 0)
    values.push(payloadSpan(text, { start: 0, end: text.length, kind: field }));
  for (const match of text.matchAll(
    /\b(?:Bearer|Basic|Digest|Token)\s+([^\s,;}\]"'`]+)/dgi,
  )) {
    const range = match.indices?.[1];
    if (range !== undefined)
      values.push({ start: range[0], end: range[1], kind: 'credential' });
  }
  return values;
}
function payloadSpan(
  text: string,
  span: CredentialValueSpan,
): CredentialValueSpan {
  let { start, end } = span;
  const quote = text[start];
  if (quote !== undefined && ['"', "'", '`'].includes(quote)) {
    start += 1;
    if (text[end - 1] === quote) end -= 1;
  }
  while (/\s/u.test(text[end - 1] ?? '') && end > start) end -= 1;
  const scheme = /^(?:Bearer|Basic|Digest|Token)\s+/iu.exec(
    text.slice(start, end),
  );
  if (scheme !== null) start += scheme[0].length;
  return { ...span, start, end };
}

function keySpans(
  text: string,
  field = '',
): readonly (readonly [number, number])[] {
  const fields = [
    ...text.matchAll(/(?<![\w-])["']?([a-z][\w-]*)["']?\s*[:=]/giu),
  ]
    .filter((match) => credentialKind(match[1] ?? '') !== null)
    .map((match) => [match.index, match.index + match[0].length] as const);
  const headers = cookieHeaderSpans(text);
  const root = cookieFieldKind(field);
  if (root !== null) headers.push({ start: 0, end: text.length, kind: root });
  for (const header of headers)
    for (const part of cookieSourceParts(
      text.slice(header.start, header.end),
      cookieFieldKind(header.kind) ?? 'cookie',
      header.start,
    ))
      if (part.attribute) fields.push([part.nameStart, part.nameEnd]);
  return fields;
}

export function credentialLiteralContexts(
  text: string,
): (start: number, end: number) => string | null {
  const keys = new Map(keySpans(text));
  const values = new Map(
    [
      ...explicitCredentialSpans(text),
      ...authenticationCredentialSpans(text),
    ].map((span) => [span.start, span]),
  );
  return (start, end) => {
    if (end <= (keys.get(start) ?? -1)) return null;
    const value = values.get(start);
    return value !== undefined && end <= value.end ? value.kind : '';
  };
}

function ambiguous(value: string): boolean {
  return /^\p{Decimal_Number}+$/u.test(value) || Array.from(value).length < 4;
}

/** Candidates are visited in order; no repeated full interval scan. */
function covering(
  ranges: readonly (readonly [number, number])[],
  merge = true,
  overlap = false,
): (start: number, end: number) => readonly [number, number] | undefined {
  const ordered = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const retained: [number, number][] = [];
  for (const range of ordered) {
    const last = retained.at(-1);
    if (merge && last !== undefined && range[0] <= last[1])
      last[1] = Math.max(last[1], range[1]);
    else retained.push([range[0], range[1]]);
  }
  let index = 0;
  return (start, end) => {
    while (index < retained.length && (retained[index]?.[1] ?? 0) <= start)
      index += 1;
    const range = retained[index];
    return range !== undefined &&
      (overlap
        ? start < range[1] && end > range[0]
        : start >= range[0] && end <= range[1])
      ? range
      : undefined;
  };
}

function partial(
  range: readonly [number, number] | undefined,
  start: number,
  end: number,
): boolean {
  return range !== undefined && (start !== range[0] || end !== range[1]);
}
export function knownCredentialSpans(
  text: string,
  vocabulary: Iterable<KnownCredential>,
  field = '',
): CredentialSpan[] {
  const known = [...vocabulary].sort((a, b) => b.value.length - a.value.length);
  const byValue = new Map(known.map((entry) => [entry.value, entry.marker]));
  const exact = byValue.get(text);
  if (exact !== undefined)
    return [{ start: 0, end: text.length, marker: exact }];
  if (known.length === 0) return [];
  const escaped = known
    .map((entry) => entry.value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
  const markers = [...text.matchAll(new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu'))]
    .filter((match) => verifiedCredentialMarker(match[0]))
    .map((match) => [match.index, match.index + match[0].length] as const);
  const keyAt = covering(keySpans(text, field));
  const sensitiveAt = covering(
    valueSpans(text, field).map((span) => [span.start, span.end]),
    true,
    true,
  );
  const markerAt = covering(markers, false);
  const result: CredentialSpan[] = [];
  for (const match of text.matchAll(new RegExp(escaped, 'gu'))) {
    const start = match.index;
    const end = start + match[0].length;
    const issued = markerAt(start, end);
    if (partial(issued, start, end)) continue;
    if (keyAt(start, end) !== undefined) continue;
    const sensitive = sensitiveAt(start, end);
    // Let the field parser learn a new WHOLE credential before replacing an old
    // credential that happens to be a prefix/subsequence of that new value.
    if (partial(sensitive, start, end)) continue;
    if (ambiguous(match[0]) && sensitive === undefined) continue;
    const marker = byValue.get(match[0]);
    if (marker !== undefined) {
      if (result.length >= 100_000)
        throw new Error('credential occurrence limit exceeded');
      result.push({ start, end, marker });
    }
  }
  return result;
}
