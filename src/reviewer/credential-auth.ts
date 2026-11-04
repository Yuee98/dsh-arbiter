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
export function authenticationCredentialSpans(
  text: string,
): CredentialValueSpan[] {
  const spans: CredentialValueSpan[] = [];
  for (const match of text.matchAll(pattern(true))) {
    const range = match.indices?.[3];
    if (range !== undefined)
      spans.push({
        start: range[0],
        end: credentialValueEnd(text, match.index, range[0], range[1]),
        kind: fieldKind(match[1] ?? ''),
      });
  }
  return spans;
}
function formatLiteral(field: string, value: string): boolean {
  return (
    /^"authorization"$/u.test(field) &&
    ['<integer 1..10>', '<integer 1-10>'].includes(value.trim())
  );
}
export function maskAuthentication(text: string, mask: CredentialMask): string {
  return text.replace(
    pattern(),
    (match: string, field: string, separator: string, value: string) =>
      formatLiteral(field, value)
        ? match
        : `${field}${separator}${mask(value, fieldKind(field))}`,
  );
}
