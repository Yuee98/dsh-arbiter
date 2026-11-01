import { CREDENTIAL_MARKER_SOURCE } from './credential-markers.js';
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
const VALUE = String.raw`(?:${CREDENTIAL_MARKER_SOURCE}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|[^\s,;\]}"'\x60]+)`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w-])((?:["']?)(?:password|passwd|pwd|token|private[_-]?key|secret[_-]?key)(?:["']?)\s*[:=]\s*)(${VALUE})`,
  'giu',
);
const COOKIE =
  /(?<![\w-])((?:["']?)(?:set-cookie|cookie)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}"']+)/giu;
const PEM =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gu;

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
  if (!['"', "'", '`'].includes(quote) || value.at(-1) !== quote)
    return { value: value.trimEnd(), quote: '' };
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
