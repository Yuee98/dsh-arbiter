/** Shared authentication grammar. Score exemptions are handled by the typed JSON copy. */
import { CREDENTIAL_MARKER_SOURCE } from './credential-markers.js';
import {
  credentialKind,
  ROTATING_CREDENTIAL_FIELD_SOURCE,
} from './credential-fields.js';
import {
  QUOTED_CREDENTIAL_VALUE,
  credentialValueEnd,
  type CredentialValueSpan,
} from './credential-syntax.js';
export type CredentialMask = (value: string, kind: string) => string;
const AUTH_FIELD = String.raw`authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|apikey|api_key|access[-_\s]*token|refresh[-_\s]*token|${ROTATING_CREDENTIAL_FIELD_SOURCE}`;
const NEXT_ASSIGNMENT = String.raw`(?<![ \t])[ \t]+(?:["']?(?:${AUTH_FIELD}|[a-z][\w-]*)["']?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*[:=]`;
const AUTH_VALUE = String.raw`(?:${QUOTED_CREDENTIAL_VALUE}|(?:${CREDENTIAL_MARKER_SOURCE}|[^,;}\]\n"'\x60])+)`;
function pattern(): RegExp {
  return new RegExp(
    `(?<![\\w-])((?:"|')?(?:${AUTH_FIELD})(?:"|')?)\\s*[:=]\\s*`,
    'giu',
  );
}
function fieldKind(field: string): string {
  return /authorization/iu.test(field)
    ? 'authorization'
    : (credentialKind(field.replace(/["']/gu, '')) ?? 'token');
}
function wholeValue(
  text: string,
  start: number,
  scheme: RegExpExecArray | null,
): boolean {
  return (
    ['"', "'", '`'].includes(text[start] ?? '') ||
    scheme?.[1]?.toLowerCase() === 'digest'
  );
}
function valueBoundary(text: string) {
  const boundaries = new RegExp(NEXT_ASSIGNMENT, 'giu');
  const queryBoundaries = /[&#]/gu;
  let next = boundaries.exec(text);
  let queryEnd = queryBoundaries.exec(text);
  return (
    start: number,
    fieldStart: number,
    scheme: RegExpExecArray | null,
  ) => {
    const from = start + (scheme?.[0].length ?? 0);
    while (next !== null && next.index < from) next = boundaries.exec(text);
    const whole = wholeValue(text, start, scheme);
    let limit = whole ? text.length : (next?.index ?? text.length);
    if (!whole && ['?', '&'].includes(text[fieldStart - 1] ?? '')) {
      while (queryEnd !== null && queryEnd.index < start)
        queryEnd = queryBoundaries.exec(text);
      limit = Math.min(limit, queryEnd?.index ?? text.length);
    }
    return limit;
  };
}
function authenticationFields(text: string) {
  // Every explicit authentication assignment requires one of these separators.
  if (!text.includes(':') && !text.includes('=')) return [];
  const fields: { field: string; value: string; start: number; end: number }[] =
    [];
  const matcher = pattern();
  const schemeMatcher = /(Bearer|Basic|Digest|Token)[ \t]+/iuy;
  const valueMatcher = new RegExp(AUTH_VALUE, 'yu');
  const boundary = valueBoundary(text);
  for (
    let match = matcher.exec(text);
    match !== null;
    match = matcher.exec(text)
  ) {
    const field = match[1] ?? '';
    const start = matcher.lastIndex;
    schemeMatcher.lastIndex = start;
    const scheme = /authorization/iu.test(field)
      ? schemeMatcher.exec(text)
      : null;
    // Both cursors advance only forwards. Never greedily read a line's entire
    // suffix and rewind to its first assignment for every credential field.
    const limit = boundary(start, match.index, scheme);
    valueMatcher.lastIndex = 0;
    const value = valueMatcher.exec(text.slice(start, limit))?.[0];
    if (value === undefined) continue;
    const end = credentialValueEnd(
      text,
      match.index,
      start,
      start + value.length,
    );
    fields.push({ field, value: text.slice(start, end), start, end });
    matcher.lastIndex = end;
  }
  return fields;
}
export function authenticationCredentialSpans(
  text: string,
): CredentialValueSpan[] {
  const spans: CredentialValueSpan[] = [];
  for (const field of authenticationFields(text))
    spans.push({
      start: field.start,
      end: field.end,
      kind: fieldKind(field.field),
    });
  return spans;
}
function formatLiteral(field: string, value: string): boolean {
  return (
    /^"authorization"$/u.test(field) &&
    ['<integer 1..10>', '<integer 1-10>'].includes(value.trim())
  );
}
export function maskAuthentication(text: string, mask: CredentialMask): string {
  let safe = '';
  let at = 0;
  for (const field of authenticationFields(text)) {
    if (formatLiteral(field.field, field.value)) continue;
    safe +=
      text.slice(at, field.start) + mask(field.value, fieldKind(field.field));
    at = field.end;
  }
  return safe + text.slice(at);
}
