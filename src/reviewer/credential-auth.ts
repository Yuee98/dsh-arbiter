/** Shared authentication grammar. Score exemptions are handled by the typed JSON copy. */
import { CREDENTIAL_MARKER_SOURCE } from './credential-markers.js';
import {
  credentialKind,
  maskExplicitFields,
  ROTATING_CREDENTIAL_FIELD_SOURCE,
} from './credential-fields.js';
import {
  QUOTED_CREDENTIAL_VALUE,
  credentialValueEnd,
  type CredentialValueSpan,
} from './credential-syntax.js';
export type CredentialMask = (value: string, kind: string) => string;
const AUTH_FIELD = String.raw`authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|apikey|api_key|access[-_\s]*token|refresh[-_\s]*token|${ROTATING_CREDENTIAL_FIELD_SOURCE}`;
const INDEPENDENT_AUTH_FIELD = new RegExp(`^(?:${AUTH_FIELD})$`, 'iu');
const NEXT_ASSIGNMENT = String.raw`(?<![ \t])[ \t]+(?:["']?(?:${AUTH_FIELD}|[a-z][\w-]*)["']?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*[:=]`;
const AUTH_VALUE = String.raw`(?:${QUOTED_CREDENTIAL_VALUE}|(?:${CREDENTIAL_MARKER_SOURCE}|[^,;}\]\n"'\x60])+)`;
const HTTP_TOKEN = String.raw`[!#$%&'*+.^_\x60|~a-z0-9-]+`;
const AUTH_PARAMETER = String.raw`(${HTTP_TOKEN})[ \t]*=[ \t]*(?:${QUOTED_CREDENTIAL_VALUE}|(?![=])(?:${CREDENTIAL_MARKER_SOURCE}|[^ \t\r\n,;}\]"'\x60]|;(?![ \t\r\n]|$))+|(?=[,\r\n]|$))`;
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
function independentField(name: string): boolean {
  const kind = credentialKind(name);
  if (kind === null || kind === 'cookie') return false;
  // Structured/query names alone do not guarantee text masking. Check the
  // actual assignment masker; cookie headers, for example, mask pairs only.
  return (
    INDEPENDENT_AUTH_FIELD.test(name) ||
    maskExplicitFields(`${name}=x`, () => '') === `${name}=`
  );
}
function schemeAt(
  text: string,
  start: number,
  limit: number,
): RegExpExecArray | null {
  const value = text.slice(start, limit);
  const matcher = new RegExp(`(${HTTP_TOKEN})[ \\t]+`, 'iuy');
  const scheme = matcher.exec(value);
  if (
    scheme === null ||
    /^(?:Bearer|Basic|Digest|Token)$/iu.test(scheme[1] ?? '')
  )
    return scheme;
  const parameter = new RegExp(`(${HTTP_TOKEN})[ \\t]*=`, 'iuy');
  parameter.lastIndex = matcher.lastIndex;
  const name = parameter.exec(value)?.[1];
  if (name === undefined || !independentField(name)) return scheme;
  const first = new RegExp(AUTH_PARAMETER, 'iuy');
  first.lastIndex = matcher.lastIndex;
  if (first.exec(value) === null) return scheme;
  // A comma continues authentication parameters even if their name is "token".
  // Without it, preserve an adjacent independent credential assignment.
  const comma = /[ \t]*,/uy;
  comma.lastIndex = first.lastIndex;
  return comma.test(value) ? scheme : null;
}
function parameterizedValueEnd(
  text: string,
  start: number,
  scheme: RegExpExecArray | null,
  limit: number,
): number | undefined {
  if (
    scheme === null ||
    ['"', "'", '`'].includes(text[start] ?? '') ||
    /^(?:Bearer|Basic|Token)$/iu.test(scheme[1] ?? '')
  )
    return undefined;
  const from = start + scheme[0].length;
  const payload = text.slice(from, limit);
  const parameter = new RegExp(AUTH_PARAMETER, 'iuy');
  if (parameter.exec(payload) === null) return undefined;
  let end = parameter.lastIndex;
  const separator = /(?:[ \t]*,[ \t]*|[ \t]+)/uy;
  for (;;) {
    separator.lastIndex = end;
    const gap = separator.exec(payload);
    if (gap === null) break;
    parameter.lastIndex = separator.lastIndex;
    const next = parameter.exec(payload);
    if (
      next === null ||
      (!gap[0].includes(',') && independentField(next[1] ?? ''))
    )
      break;
    end = parameter.lastIndex;
  }
  return from + end;
}
function valueBoundary(text: string) {
  const boundaries = new RegExp(NEXT_ASSIGNMENT, 'giu');
  const queryBoundaries = /[&#]/gu;
  let next = boundaries.exec(text);
  let queryEnd = queryBoundaries.exec(text);
  return {
    hard: (start: number, fieldStart: number) => {
      if (
        ['"', "'", '`'].includes(text[start] ?? '') ||
        !['?', '&'].includes(text[fieldStart - 1] ?? '')
      )
        return text.length;
      while (queryEnd !== null && queryEnd.index < start)
        queryEnd = queryBoundaries.exec(text);
      return queryEnd?.index ?? text.length;
    },
    adjacent: (from: number) => {
      while (next !== null && next.index < from) next = boundaries.exec(text);
      return next?.index ?? text.length;
    },
  };
}
function literalValueEnd(
  matcher: RegExp,
  text: string,
  start: number,
  limit: number,
): number | undefined {
  matcher.lastIndex = 0;
  const value = matcher.exec(text.slice(start, limit))?.[0];
  return value === undefined ? undefined : start + value.length;
}
function authenticationFields(text: string) {
  // Every explicit authentication assignment requires one of these separators.
  if (!text.includes(':') && !text.includes('=')) return [];
  const fields: { field: string; value: string; start: number; end: number }[] =
    [];
  const matcher = pattern();
  const valueMatcher = new RegExp(AUTH_VALUE, 'yu');
  const boundary = valueBoundary(text);
  for (
    let match = matcher.exec(text);
    match !== null;
    match = matcher.exec(text)
  ) {
    const field = match[1] ?? '';
    const start = matcher.lastIndex;
    const hard = boundary.hard(start, match.index);
    const scheme = /authorization/iu.test(field)
      ? schemeAt(text, start, hard)
      : null;
    // Both cursors advance only forwards. Never greedily read a line's entire
    // suffix and rewind to its first assignment for every credential field.
    const limit = wholeValue(text, start, scheme)
      ? hard
      : Math.min(hard, boundary.adjacent(start + (scheme?.[0].length ?? 0)));
    const valueEnd =
      parameterizedValueEnd(text, start, scheme, hard) ??
      literalValueEnd(valueMatcher, text, start, limit);
    if (valueEnd === undefined) continue;
    const end = credentialValueEnd(text, match.index, start, valueEnd);
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
