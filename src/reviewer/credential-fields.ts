import { CREDENTIAL_MARKER_SOURCE } from './credential-markers.js';
import {
  QUOTED_CREDENTIAL_VALUE,
  credentialValueEnd,
} from './credential-syntax.js';
import type { CredentialValueSpan } from './credential-syntax.js';
/** Explicit credential syntax only: no entropy, string-length or generic key rule. */
import type { CredentialMask } from './credential-auth.js';

export type CredentialKind =
  'credential' | 'password' | 'token' | 'cookie' | 'private-key';

export function credentialKind(field: string): CredentialKind | null {
  const key = field.toLowerCase().replace(/[-_\s]/gu, '');
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
const COOKIE = new RegExp(
  String.raw`(?<![\w-])((?:["']?)(?:set-cookie|cookie)(?:["']?)\s*[:=]\s*)(${QUOTED_CREDENTIAL_VALUE}|[^\r\n}"']+)`,
  'giu',
);
const PEM =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gu;

export function isCookieAttribute(name: string): boolean {
  return /^(?:path|domain|expires|max-age|samesite)$/iu.test(name);
}

/** Value spans from the exact same assignment/cookie grammar used by masking. */
export function explicitCredentialSpans(text: string): CredentialValueSpan[] {
  const spans: CredentialValueSpan[] = [];
  for (const [pattern, kind] of [
    [ASSIGNMENT, 'credential'],
    [COOKIE, 'cookie'],
  ] as const) {
    for (const match of text.matchAll(
      new RegExp(pattern.source, `${pattern.flags}d`),
    )) {
      const range = match.indices?.[2];
      if (range !== undefined)
        spans.push({
          start: range[0],
          end: credentialValueEnd(text, match.index, range[0], range[1]),
          kind:
            kind === 'cookie'
              ? kind
              : (credentialKind((match[1] ?? '').replace(/["':=\s]/gu, '')) ??
                'token'),
        });
    }
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
      const category = /authorization/iu.test(field) ? 'authorization' : kind;
      return hold(`${separator}${field}=${mask(value, category)}`);
    },
  );
}

export function maskExplicitFields(text: string, mask: CredentialMask): string {
  return text
    .replace(PEM, (value) => mask(value, 'private-key'))
    .replace(
      COOKIE,
      (_match: string, prefix: string, value: string) =>
        `${prefix}${mask(value, 'cookie')}`,
    )
    .replace(
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
