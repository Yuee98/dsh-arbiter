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
const NEXT_ASSIGNMENT = new RegExp(
  String.raw`[ \t]+(?:["']?(?:${AUTH_FIELD}|[a-z][\w-]*)["']?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*[:=]`,
  'iu',
);
const AUTH_VALUE = String.raw`(?:${QUOTED_CREDENTIAL_VALUE}|(?:${CREDENTIAL_MARKER_SOURCE}|[^,;}\]\n"'\x60])+)`;
function pattern(indices = false): RegExp {
  return new RegExp(
    `(?<![\\w-])((?:"|')?(?:${AUTH_FIELD})(?:"|')?)(\\s*[:=]\\s*)(${AUTH_VALUE})`,
    indices ? 'gidu' : 'giu',
  );
}
function fieldKind(field: string): string {
  return /authorization/iu.test(field)
    ? 'authorization'
    : (credentialKind(field.replace(/["']/gu, '')) ?? 'token');
}
function adjacentValueEnd(field: string, value: string): number {
  if (['"', "'", '`'].includes(value[0] ?? '')) return value.length;
  const scheme = /authorization/iu.test(field)
    ? /^(Bearer|Basic|Digest|Token)[ \t]+/iu.exec(value)
    : null;
  // Digest parameters are part of the authentication value, not new fields.
  if (scheme?.[1]?.toLowerCase() === 'digest') return value.length;
  const from = scheme?.[0].length ?? 0;
  const next = NEXT_ASSIGNMENT.exec(value.slice(from));
  return next === null ? value.length : from + next.index;
}
function authenticationFields(text: string) {
  const fields: { field: string; value: string; start: number; end: number }[] =
    [];
  const matcher = pattern(true);
  for (
    let match = matcher.exec(text);
    match !== null;
    match = matcher.exec(text)
  ) {
    const range = match.indices?.[3];
    if (range === undefined) continue;
    const field = match[1] ?? '';
    const start = range[0];
    const end = credentialValueEnd(
      text,
      match.index,
      start,
      start + adjacentValueEnd(field, match[3] ?? ''),
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
