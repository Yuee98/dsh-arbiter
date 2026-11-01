import {
  quotedCredentialSpans,
  structuredJson,
} from './credential-literals.js';
/** Bounded, transient credential vocabulary. Never serialize a raw-value mapping.
 * IDs are scoped HMACs, stable within this process; restart continuity and arbitrary
 * unlabelled/unknown PII are deliberately outside automatic recognition.
 */
import {
  credentialIdentity,
  credentialMarker,
  verifiedCredentialMarker,
  CREDENTIAL_MARKER_SOURCE,
} from './credential-markers.js';
import { maskAuthentication } from './credential-auth.js';
import {
  credentialKind,
  maskExplicitFields,
  quotedValue,
  reQuote,
  type CredentialKind,
} from './credential-fields.js';

const MAX_TEXT = 16 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_VALUES = 1024;
const MAX_VOCABULARY = 256 * 1024;
const MARKER = new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu');
const AUTH_WORDS =
  /^(?:(?:approved|allowed|denied|granted|forbidden|permitted|delegated)(?:$|\s+(?:for|to|by|within|only|under)\b)|true$|false$|none$)/iu;
interface Secret {
  readonly value: string;
  readonly marker: string;
}

export class CredentialRedactor {
  readonly #scope: string;
  readonly #secrets = new Map<string, Secret>();
  readonly #parent: CredentialRedactor | undefined;
  readonly #onLearn: ((bytes: number) => void) | undefined;
  #bytes = 0;
  #failed = false;
  #jsonDepth = 0;
  constructor(
    scope: string,
    known: readonly string[] = [],
    parent?: CredentialRedactor,
    onLearn?: (bytes: number) => void,
  ) {
    this.#scope = scope;
    this.#parent = parent;
    this.#onLearn = onLearn;
    if (parent !== undefined) {
      for (const value of parent.#secrets.values())
        this.#secrets.set(value.value, value);
      this.#bytes = parent.#bytes;
    }
    this.addKnown(known);
  }
  fork(): CredentialRedactor {
    this.check('');
    return new CredentialRedactor(this.#scope, [], this);
  }
  addKnown(values: readonly string[]): void {
    for (const value of values) this.learn(value, 'credential', true);
  }
  sensitiveValue(value: unknown, kind: CredentialKind): unknown {
    this.discover(value);
    const active = new WeakSet<object>();
    let nodes = 0;
    const copy = (item: unknown): unknown => {
      nodes += 1;
      if (nodes > MAX_NODES) this.fail();
      if (typeof item === 'string' || typeof item === 'number')
        return this.learn(String(item), kind);
      if (item === null || typeof item !== 'object') return item;
      if (active.has(item)) return '[circular]';
      active.add(item);
      const result = Array.isArray(item)
        ? item.map(copy)
        : Object.fromEntries(
            Object.entries(item).map(([key, entry]) => [
              this.knownText(key),
              copy(entry),
            ]),
          );
      active.delete(item);
      return result;
    };
    return copy(value);
  }
  private fail(): never {
    this.#failed = true;
    throw new Error('credential redaction resource limit exceeded');
  }
  private check(text: string): void {
    this.#parent?.check('');
    if (this.#failed || text.length > MAX_TEXT) this.fail();
  }
  private learn(value: string, kind: CredentialKind, known = false): string {
    this.check(value);
    const old = this.#secrets.get(value);
    if (old !== undefined) return old.marker;
    if (value.length === 0 || (!known && this.isMarker(value))) return value;
    const bytes = Buffer.byteLength(value);
    if (
      this.#secrets.size >= MAX_VALUES ||
      this.#bytes + bytes > MAX_VOCABULARY
    )
      this.fail();
    if (this.#parent === undefined) {
      try {
        this.#onLearn?.(bytes);
      } catch {
        this.fail();
      }
    }
    const identity = credentialIdentity(this.#scope, value);
    const marker =
      this.#parent === undefined
        ? credentialMarker(kind, identity)
        : this.#parent.learn(value, kind, known);
    this.#secrets.set(value, { value, marker });
    this.#bytes += bytes;
    return marker;
  }
  private isMarker(value: string): boolean {
    return verifiedCredentialMarker(value);
  }
  private opaque(value: string): string {
    return credentialMarker(
      'credential',
      credentialIdentity(this.#scope, value, 'opaque'),
    );
  }
  private mask = (raw: string, kind: string): string => {
    const { value, quote } = quotedValue(raw);
    if (kind === 'authorization' && AUTH_WORDS.test(value)) return raw;
    // A malformed object's delimiter is not a credential vocabulary entry.
    if (kind === 'authorization' && quote === '' && ['{', '['].includes(value))
      return this.opaque(value);
    if (kind === 'cookie') return reQuote(this.cookies(value), quote);
    const category: CredentialKind =
      kind === 'password' || kind === 'private-key' ? kind : 'token';
    const scheme =
      kind === 'authorization'
        ? /^(Bearer|Basic|Digest|Token)\s+(.+)$/isu.exec(value)
        : null;
    if (scheme !== null)
      return reQuote(
        `${scheme[1] ?? ''} ${this.learn(scheme[2] ?? '', 'token')}`,
        quote,
      );
    return reQuote(this.learn(value, category), quote);
  };
  private cookies(value: string): string {
    if (!value.includes('=')) return this.learn(value, 'cookie');
    return value.replace(
      /(^|;\s*)([^=;\s]+)=([^;]*)/gu,
      (_match: string, separator: string, name: string, secret: string) => {
        if (/^(?:path|domain|expires|max-age|samesite)$/iu.test(name))
          return `${separator}${name}=${secret}`;
        return `${separator}${name}=${this.learn(secret, 'cookie')}`;
      },
    );
  }
  private nestedField(parent: string, key: string): string {
    if (key !== 'value' || credentialKind(parent) === null) return key;
    return /authorization/iu.test(parent) ? 'Authorization' : parent;
  }
  private discoverScalar(
    item: string | number,
    field: string,
    scores: boolean,
  ): void {
    const kind = credentialKind(field);
    if (typeof item === 'number') {
      if (kind !== null && !(scores && field === 'authorization'))
        this.learn(String(item), kind);
      return;
    }
    if (kind !== null) {
      this.mask(item, /authorization/iu.test(field) ? 'authorization' : kind);
      return;
    }
    this.scan(this.knownText(item), scores);
  }
  discover(value: unknown, scores = false): void {
    let nodes = 0;
    let chars = 0;
    const seen = new WeakSet<object>();
    const visit = (item: unknown, field = '', depth = 0): void => {
      nodes += 1;
      if (nodes > MAX_NODES || depth > 64) this.fail();
      if (typeof item === 'string' || typeof item === 'number') {
        if (typeof item === 'string') chars += item.length;
        if (chars > MAX_TEXT) this.fail();
        this.discoverScalar(item, field, scores);
      } else if (item !== null && typeof item === 'object') {
        if (seen.has(item)) return;
        seen.add(item);
        for (const [key, entry] of Object.entries(item)) {
          visit(key, '', depth + 1);
          visit(
            entry,
            Array.isArray(item) ? field : this.nestedField(field, key),
            depth + 1,
          );
        }
      }
    };
    try {
      visit(value);
    } catch {
      this.#failed = true;
      throw new Error('credential redaction could not safely process material');
    }
  }
  private scan(text: string, scores: boolean): string {
    this.check(text);
    // Protect issued syntax from being re-read as `token:...` inside a marker.
    // Tokens are local and absent from input; only exact tokens are restored.
    let prefix = '\0crd';
    while (text.includes(prefix)) prefix += 'x';
    const replacements = new Map<string, string>();
    const protect = (value: string): string =>
      value.replace(MARKER, (marker) => {
        if (!this.isMarker(marker)) return marker;
        const token = `${prefix}${String(replacements.size)}\0`;
        replacements.set(token, marker);
        return token;
      });
    const restore = (value: string): string => {
      let restored = value;
      for (const [token, marker] of replacements)
        restored = restored.replaceAll(token, () => marker);
      return restored;
    };
    const mask = (value: string, kind: string): string =>
      protect(this.mask(restore(value), kind));
    const masked = maskExplicitFields(
      maskAuthentication(protect(text), mask, scores),
      mask,
    );
    return restore(masked);
  }
  knownText(text: string): string {
    this.check(text);
    const secrets = [...this.#secrets.values()].sort(
      (a, b) => b.value.length - a.value.length,
    );
    if (secrets.length === 0) return text;
    const byValue = new Map(
      secrets.map((entry) => [entry.value, entry.marker]),
    );
    const escaped = secrets.map(({ value }) =>
      value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    );
    const known = new RegExp(escaped.join('|'), 'gu');
    const pattern = new RegExp(`${MARKER.source}|${escaped.join('|')}`, 'gu');
    return text.replace(
      pattern,
      (value) =>
        byValue.get(value) ??
        (this.isMarker(value)
          ? value
          : value.replace(known, (secret) => byValue.get(secret) ?? secret)),
    );
  }
  private discoverAnswer(text: string): void {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    this.discover(body, true);
  }
  text(text: string, scores = false): string {
    this.check(text);
    const exact = this.#secrets.get(text);
    if (exact !== undefined) return exact.marker;
    const first = text.trimStart()[0];
    if (scores) this.discoverAnswer(text);
    if (!scores && (first === '{' || first === '[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* Ordinary prose, not a JSON value. */
      }
      if (parsed !== null && typeof parsed === 'object') {
        if (this.#jsonDepth >= 64) this.fail();
        this.#jsonDepth += 1;
        try {
          const cleaned = this.value(parsed);
          return JSON.stringify(cleaned) === JSON.stringify(parsed)
            ? text
            : JSON.stringify(cleaned);
        } finally {
          this.#jsonDepth -= 1;
        }
      }
    }
    // Decode quoted literals for exact known-value matching without exposing a
    // JSON-escaped echo. Unchanged prose/formatting is kept byte-for-byte.
    const quoted = text.replace(/"(?:\\.|[^"\\])*"/gu, (literal) => {
      let value: unknown;
      try {
        value = JSON.parse(literal);
      } catch {
        return literal;
      }
      if (typeof value !== 'string') return literal;
      const cleaned = this.knownText(value);
      return cleaned === value ? literal : JSON.stringify(cleaned);
    });
    return this.knownText(this.scan(this.knownText(quoted), scores));
  }
  value(value: unknown, scores = false): unknown {
    this.discover(value, scores);
    const seen = new WeakSet<object>();
    let nodes = 0;
    let chars = 0;
    const copy = (item: unknown, field = ''): unknown => {
      nodes += 1;
      if (nodes > MAX_NODES) this.fail();
      if (typeof item === 'string') {
        const cleaned = this.text(item, scores);
        chars += cleaned.length;
        if (chars > MAX_TEXT) this.fail();
        return cleaned;
      }
      if (
        typeof item === 'number' &&
        credentialKind(field) !== null &&
        !(scores && field === 'authorization')
      )
        return this.knownText(String(item));
      if (item === null || typeof item !== 'object') return item;
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      const result = Array.isArray(item)
        ? Object.values(item).map((entry) => copy(entry, field))
        : Object.fromEntries(
            Object.entries(item).map(([key, entry]) => [
              this.text(key, scores),
              copy(entry, this.nestedField(field, key)),
            ]),
          );
      seen.delete(item);
      return result;
    };
    try {
      return copy(value);
    } catch {
      this.#failed = true;
      throw new Error('credential redaction could not safely process material');
    }
  }
  /** Continuations of ONE logical text only. Independent channels use separate calls. */
  textBlocks(blocks: readonly string[]): string {
    if (blocks.length > MAX_NODES) this.fail();
    if (blocks.reduce((total, block) => total + block.length, 0) > MAX_TEXT)
      this.fail();
    const joined = blocks.join('');
    const processed = this.text(joined);
    if (structuredJson(joined)) return processed;
    // Preserve normal block separators; carry a secret spanning a split as one marker.
    const ranges: { start: number; end: number; marker: string }[] = [];
    for (const entry of this.#secrets.values()) {
      let start = joined.indexOf(entry.value);
      while (start >= 0) {
        if (ranges.length >= MAX_NODES) this.fail();
        ranges.push({
          start,
          end: start + entry.value.length,
          marker: entry.marker,
        });
        start = joined.indexOf(entry.value, start + entry.value.length);
      }
    }
    ranges.push(
      ...quotedCredentialSpans(
        joined,
        this.#secrets.values(),
        MAX_NODES - ranges.length,
      ),
    );
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const output: string[] = [];
    let offset = 0;
    for (const block of blocks) {
      let cursor = 0;
      let text = '';
      for (const range of ranges) {
        if (
          range.end <= offset ||
          range.start >= offset + block.length ||
          range.end <= offset + cursor
        )
          continue;
        const start = Math.max(cursor, range.start - offset);
        text +=
          block.slice(cursor, start) +
          (range.start >= offset ? range.marker : '');
        cursor = Math.min(block.length, range.end - offset);
      }
      output.push(this.text(text + block.slice(cursor)));
      offset += block.length;
    }
    return output.join('\n');
  }
}
