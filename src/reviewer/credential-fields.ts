import { CREDENTIAL_MARKER_SOURCE } from './credential-markers.js';
import {
  QUOTED_CREDENTIAL_VALUE,
  credentialValueEnd,
} from './credential-syntax.js';
import type { CredentialValueSpan } from './credential-syntax.js';
import { cookieFieldKind, cookieHeaderSpans } from './credential-cookies.js';
import { applyCredentialSpans } from './credential-literals.js';
/** Explicit credential syntax only: no entropy, string-length or generic key rule. */
import type { CredentialMask } from './credential-auth.js';

export type CredentialKind =
  'credential' | 'password' | 'token' | 'cookie' | 'private-key';

/** Explicit rotation names only; suffixes such as ApiKeyCount are not fields. */
export const ROTATING_CREDENTIAL_FIELD_SOURCE = String.raw`(?:previous|old|current|new|next)[-_\s]*(?:api[-_\s]*key|access[-_\s]*token|refresh[-_\s]*token|token|password|passwd|pwd|private[-_\s]*key|secret[-_\s]*key)`;
const ROTATING_CREDENTIAL_FIELD = new RegExp(
  `^(?:${ROTATING_CREDENTIAL_FIELD_SOURCE})$`,
  'iu',
);

export function credentialKind(field: string): CredentialKind | null {
  let key = field.toLowerCase().replace(/[-_\s]/gu, '');
  if (ROTATING_CREDENTIAL_FIELD.test(field))
    key = key.replace(/^(?:previous|old|current|new|next)/u, '');
  if (['password', 'passwd', 'pwd'].includes(key)) return 'password';
  if (
    [
      'token',
      'accesstoken',
      'refreshtoken',
      'apikey',
      'xapikey',
      'xgoogapikey',
    ].includes(key)
  )
    return 'token';
  if (['cookie', 'setcookie'].includes(key)) return 'cookie';
  if (['privatekey', 'secretkey'].includes(key)) return 'private-key';
  if (['authorization', 'proxyauthorization'].includes(key)) return 'token';
  return null;
}

/** A complete quoted literal or a bounded-to-delimiter unquoted assignment. */
const VALUE = String.raw`(?:${QUOTED_CREDENTIAL_VALUE}|(?:${CREDENTIAL_MARKER_SOURCE}|[^\s,;\]}"'\x60])+)`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w-])((?:["']?)(?:password|passwd|pwd|token|private[_-]?key|secret[_-]?key)(?:["']?)\s*[:=]\s*)(${VALUE})`,
  'giu',
);
const PEM =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gu;

/** Value spans from the exact same assignment/cookie grammar used by masking. */
export function explicitCredentialSpans(text: string): CredentialValueSpan[] {
  const spans: CredentialValueSpan[] = [...cookieHeaderSpans(text)];
  for (const match of text.matchAll(
    new RegExp(ASSIGNMENT.source, `${ASSIGNMENT.flags}d`),
  )) {
    const range = match.indices?.[2];
    if (range !== undefined)
      spans.push({
        start: range[0],
        end: credentialValueEnd(text, match.index, range[0], range[1]),
        kind:
          credentialKind((match[1] ?? '').replace(/["':=\s]/gu, '')) ?? 'token',
      });
  }
  return spans;
}

/** Query framing is independent of ordinary header/assignment value grammar. */
export function maskCredentialQueries(
  text: string,
  mask: CredentialMask,
  hold: (safe: string) => string,
): string {
  return text.replace(
    /([?&])([a-z][\w-]*)=([^&#\s"'`]+)/giu,
    (match: string, separator: string, field: string, value: string) => {
      const kind = credentialKind(field);
      if (kind === null) return match;
      const category = /authorization/iu.test(field)
        ? 'authorization'
        : (cookieFieldKind(field) ?? kind);
      return hold(`${separator}${field}=${mask(value, category)}`);
    },
  );
}

export function maskExplicitFields(text: string, mask: CredentialMask): string {
  const keys = text.replace(PEM, (value) => mask(value, 'private-key'));
  const cookies =
    applyCredentialSpans(
      [keys],
      cookieHeaderSpans(keys).map((span) => ({
        ...span,
        marker: mask(keys.slice(span.start, span.end), span.kind),
      })),
    )[0] ?? '';
  return cookies.replace(
    ASSIGNMENT,
    (_match: string, prefix: string, value: string) =>
      `${prefix}${mask(value, /pass|pwd/iu.test(prefix) ? 'password' : /key/iu.test(prefix) ? 'private-key' : 'token')}`,
  );
}

export function quotedValue(value: string): {
  readonly value: string;
  readonly quote: string;
} {
  const quote = value[0] ?? '';
  if (!['"', "'", '`'].includes(quote))
    return { value: value.trimEnd(), quote: '' };
  if (value.at(-1) !== quote)
    return { value: value.slice(1).trimEnd(), quote: '' };
  if (quote === '"') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return { value: parsed, quote };
    } catch {
      /* Invalid JSON is still untrusted text. */
    }
  }
  return { value: value.slice(1, -1), quote };
}

export function reQuote(value: string, quote: string): string {
  return quote === '"'
    ? JSON.stringify(value)
    : quote.length === 0
      ? value
      : `${quote}${value}${quote}`;
}
