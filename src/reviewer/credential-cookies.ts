/** Shared Cookie/Set-Cookie framing and roles, before any material replacement. */
import {
  QUOTED_CREDENTIAL_VALUE,
  credentialValueEnd,
  type CredentialValueSpan,
} from './credential-syntax.js';
import {
  CREDENTIAL_MARKER_SOURCE,
  verifiedCredentialMarker,
} from './credential-markers.js';

export type CookieFieldKind = 'cookie' | 'set-cookie';
export interface CookiePart {
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly attribute: boolean;
}
const QUOTES = new Set(['"', "'", '`']);
const QUOTED = new RegExp(`^(?:${QUOTED_CREDENTIAL_VALUE})`, 'u');
const HEADER_END = new Set(['\r', '\n']);
const PART_END = new Set([';']);
const FIELD =
  /(?<![\w-])(["'`]?)(set[-_]?cookie|cookie)(["'`]?)(\s*[:=]\s*)/giu;
export function cookieFieldKind(field: string): CookieFieldKind | null {
  const key = field.toLowerCase().replace(/[-_\s]/gu, '');
  return key === 'cookie'
    ? 'cookie'
    : key === 'setcookie'
      ? 'set-cookie'
      : null;
}
function quotedEnd(text: string, start: number): number {
  return start + (QUOTED.exec(text.slice(start))?.[0].length ?? 1);
}
function boundary(
  text: string,
  start: number,
  end: ReadonlySet<string>,
  outer = '',
): number {
  let afterEquals = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (afterEquals && QUOTES.has(char)) {
      at = quotedEnd(text, at) - 1;
      afterEquals = false;
    } else {
      if (end.has(char) || char === outer) return at;
      afterEquals = char === '=' || (afterEquals && /\s/u.test(char));
    }
  }
  return text.length;
}
function issuedMarkerAt(text: string): (at: number) => boolean {
  const markers = [
    ...text.matchAll(new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu')),
  ].filter((match) => verifiedCredentialMarker(match[0]));
  let markerAt = 0;
  return (at) => {
    while (
      markers[markerAt] !== undefined &&
      (markers[markerAt]?.index ?? 0) + (markers[markerAt]?.[0].length ?? 0) <=
        at
    )
      markerAt += 1;
    const issued = markers[markerAt];
    return (
      issued !== undefined &&
      at >= issued.index &&
      at < issued.index + issued[0].length
    );
  };
}
export function cookieHeaderSpans(text: string): CredentialValueSpan[] {
  const spans: CredentialValueSpan[] = [];
  const issued = issuedMarkerAt(text);
  for (const match of text.matchAll(FIELD)) {
    if (issued(match.index)) continue;
    if (match.index < (spans.at(-1)?.end ?? 0)) continue;
    if (spans.length >= 100_000)
      throw new Error('credential Cookie field limit exceeded');
    const start = match.index + match[0].length;
    const outer = match[1] && !match[3] ? match[1] : '';
    const end =
      !outer && QUOTES.has(text[start] ?? '')
        ? quotedEnd(text, start)
        : boundary(text, start, HEADER_END, outer);
    spans.push({
      start,
      end: credentialValueEnd(text, match.index, start, end),
      kind: cookieFieldKind(match[2] ?? '') ?? 'cookie',
    });
  }
  return spans;
}
function attribute(name: string, pair: boolean): boolean {
  return pair
    ? /^(?:path|domain|expires|max-age|samesite)$/iu.test(name)
    : /^(?:secure|httponly|partitioned)$/iu.test(name);
}
function trimmed(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  return { start, end };
}
function part(
  text: string,
  start: number,
  end: number,
  attributes: boolean,
): CookiePart | null {
  ({ start, end } = trimmed(text, start, end));
  if (start === end) return null;
  const equal = text.indexOf('=', start);
  const pair = equal >= start && equal < end;
  const nameEnd = trimmed(text, start, pair ? equal : end).end;
  const valueStart = trimmed(text, pair ? equal + 1 : start, end).start;
  return {
    nameStart: start,
    nameEnd,
    valueStart,
    valueEnd: end,
    attribute: attributes && attribute(text.slice(start, nameEnd), pair),
  };
}
export function cookieParts(
  text: string,
  kind: CookieFieldKind,
): readonly CookiePart[] {
  const parts: CookiePart[] = [];
  let start = 0;
  let hasCookie = false;
  while (start < text.length) {
    if (parts.length >= 100_000)
      throw new Error('credential Cookie part limit exceeded');
    const end = boundary(text, start, PART_END);
    const current = part(text, start, end, kind === 'set-cookie' && hasCookie);
    if (current !== null) {
      if (parts.length === 0) hasCookie = current.valueStart > current.nameEnd;
      parts.push(current);
    }
    start = end + 1;
  }
  return parts;
}
/** Lexical offsets for a field value that may have one presentation quote. */
export function cookieSourceParts(
  text: string,
  kind: CookieFieldKind,
  offset = 0,
): readonly CookiePart[] {
  const quote = text[0] ?? '';
  if (QUOTES.has(quote)) {
    text = text.slice(1, text.at(-1) === quote ? -1 : undefined);
    offset += 1;
  }
  return cookieParts(text, kind).map((item) => ({
    ...item,
    nameStart: item.nameStart + offset,
    nameEnd: item.nameEnd + offset,
    valueStart: item.valueStart + offset,
    valueEnd: item.valueEnd + offset,
  }));
}
